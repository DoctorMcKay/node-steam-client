'use strict';
/* jshint node:true, esversion:6, latedef:nofunc */

var SteamCrypto = require('@doctormckay/steam-crypto');
var ByteBuffer = require('bytebuffer');
var Dgram = require('dgram');

module.exports = UDPConnection;

const MAGIC = 'VS01';
const CHALLENGE_MASK = 0xA426DF2B;
const MAX_PAYLOAD = 0x4DC;

require('util').inherits(UDPConnection, require('events').EventEmitter);

/*
We are expected to implement the following events:
	- packet (a complete message from Steam was received)
	- close (the connection was closed)
	- error (a fatal error occurred, but close will also be emitted)
	- connect (a successful connection was established)
	- end (emitted after close)
	- timeout (emitted after setTimeout elapses)

We are expected to implement the following methods:
	- end() (request a disconnect)
	- destroy() (immediately kill the connection, without notifying the other side)
	- connect(options) (start connecting to the remote server)
		- port (the port number of the remote host)
		- host (the hostname or IP address of the remote host)
		- localAddress (the local IP we want to bind to, optional)
		- localPort (the local port we want to bind to, optional)
	- send(buffer) (send a raw buffer through the connection, encrypting if necessary)
	- setTimeout(ms[, callback]) (identical to Socket's setTimeout)

Terminology:
	- A "message" is a single whole message which will be sent to or received from the CM. It can be split across
		multiple packets.
	- A "packet" is a single datagram. It can contain between 0 and 1 messages. A message may be split across multiple
		packets.
 */

const RESEND_DELAY = 3;      // Seconds to wait for ack before resending packets
const ACK_TIMEOUT = 15;      // Seconds to wait for ack to a packet before considering the connection dead
const AHEAD_COUNT = 5;       // Maximum number of packets that we can be waiting on at a time

var EUdpPacketType = require('../index.js').EUdpPacketType;
var EConnectionState = {
	"Disconnected": 1,
	"ChallengeReqSent": 2,
	"ConnectSent": 3,
	"Connected": 4,
	"Disconnecting": 5
};

var g_SourceConnID = 512;

/**
 * @augments EventEmitter
 * @constructor
 */
function UDPConnection() {
	// External properties
	this.sessionKey = null;

	// Internal properties
	this.state = EConnectionState.Disconnected;
	this.socket = null;
	this.remoteAddress = null;
	this.timeout = null;
	this.timeoutTime = 0;
	this.ackTimeout = null;
	this.flushInterval = null;
}

/**
 * Set the socket's timeout. The `timeout` event will be emitted after this much time of inactivity.
 * @param {int} ms - Time in milliseconds of inactivity before timing out
 * @param {function} callback - Added as a one-time event listener of `timeout`
 */
UDPConnection.prototype.setTimeout = function(ms, callback) {
	this.timeoutTime = ms;
	this._resetTimeout();

	if(callback) {
		this.once('timeout', callback);
	}
};

/**
 * Send data over the connection.
 * @param {Buffer} data
 */
UDPConnection.prototype.send = function(data) {
	this.sendMessage(EUdpPacketType.Data, data);
};

/**
 * Disconnect gracefully.
 */
UDPConnection.prototype.end = function() {
	if(this.state == EConnectionState.ChallengeReqSent) {
		this.destroy();
	}

	if(this.state == EConnectionState.Disconnected || this.state == EConnectionState.Disconnecting) {
		throw new Error("Already disconnecting or disconnected.");
	}

	this.state = EConnectionState.Disconnecting;
	this.sendMessage(EUdpPacketType.Disconnect);

	var self = this;
	var connID = this.sourceConnID;
	setTimeout(function() {
		if(connID == self.sourceConnID && self.state == EConnectionState.Disconnecting) {
			self.destroy();
		}
	}, 15000)
};

/**
 * Completely destroy the connection without notifying the other end.
 */
UDPConnection.prototype.destroy = function() {
	this.state = EConnectionState.Disconnected;
	this.emit('close');
	this.emit('end');

	clearInterval(this.flushInterval);
	this.flushInterval = null;

	this.socket.close();
};

UDPConnection.prototype._resetTimeout = function() {
	clearTimeout(this.timeout);

	if(this.timeoutTime) {
		var self = this;
		this.timeout = setTimeout(function() {
			self.emit('timeout');
		}, this.timeoutTime);
	}
};

/**
 * Attempt to establish a new connection.
 * @param {object} options
 */
UDPConnection.prototype.connect = function(options) {
	if(this.state != EConnectionState.Disconnected) {
		throw new Error("Already connected");
	}

	this.socket = Dgram.createSocket('udp4');
	this.remoteAddress = {"address": options.host, "port": options.port};

	this.outSeq = 1;        // the sequence number of the next packet we send
	this.outSeqSent = 0;    // the highest sequence number that we have sent over the wire
	this.outSeqAcked = 0;   // the highest sequence number they have acked receiving

	this.inSeq = 0;         // the highest sequence number we have received in order
	this.inSeqAcked = 0;    // the highest sequence number we have acked
	this.inSeqHandled = 0;  // the highest sequence number that has been dispatched to be handled

	this.sourceConnID = g_SourceConnID;
	this.remoteConnID = 0;

	this.outPackets = {};
	this.inPackets = {};

	this.serverLoad = null;

	// Bind to an interface
	this.socket.bind(options.localPort, options.localAddress);

	var self = this;

	this.socket.on('error', function(err) {
		self.emit('error', err);
		self.emit('close');
		self.emit('end');
	});

	this.socket.on('listening', function() {
		// Our socket is bound successfully. Let's connect.
		g_SourceConnID += 256;

		// Send off the challenge request
		self.state = EConnectionState.ChallengeReqSent;
		self.sendMessage(EUdpPacketType.ChallengeReq);
	});

	this.socket.on('message', function(msg, rinfo) {
		if(rinfo.address != self.remoteAddress.address || rinfo.port != self.remoteAddress.port) {
			self.emit('debug', "Got message from bad host " + rinfo.address + ":" + rinfo.port + ", discarding");
			return;
		}

		self.handlePacket(msg);
	});
};

UDPConnection.prototype.sendMessage = function(type, data) {
	switch(type) {
		case EUdpPacketType.ChallengeReq:
			data = new Buffer(0);
			break;

		case EUdpPacketType.Connect:
			var challenge = data;
			data = new Buffer(4);
			data.writeUInt32LE((challenge ^ CHALLENGE_MASK) >>> 0, 0);
			break;

		case EUdpPacketType.Disconnect:
			data = new Buffer(0);
			break;

		case EUdpPacketType.Data:
			if(ByteBuffer.isByteBuffer(data)) {
				data = data.toBuffer();
			}

			if(this.sessionKey) {
				if (this.useHmac) {
					data = SteamCrypto.symmetricEncryptWithHmacIv(data, this.sessionKey);
				} else {
					data = SteamCrypto.symmetricEncrypt(data, this.sessionKey);
				}
			}

			break;

		case EUdpPacketType.Datagram:
			data = new Buffer(0);
			break;

		default:
			this.emit('debug', "Tried to send bad packet type " + type);
			return;
	}

	var msgStartSeq = this.outSeq;
	var msgSize = data.length;
	var packetsInMsg = Math.max(Math.ceil(msgSize / MAX_PAYLOAD), 1);

	// If there is no data, don't bother with splitting anything up
	if(msgSize == 0) {
		this.sendPacket(type, data, packetsInMsg, msgStartSeq, msgSize);
		return;
	}

	for(var i = 0; i < packetsInMsg; i++) {
		this.sendPacket(type, data.slice(i * MAX_PAYLOAD, Math.min((i + 1) * MAX_PAYLOAD, data.length)), packetsInMsg, msgStartSeq, msgSize);
	}
};

UDPConnection.prototype.sendPacket = function(type, payload, packetsInMsg, msgStartSeq, msgSize) {
	var seqThis;
	if(type == EUdpPacketType.Datagram) {
		seqThis = 0;
		msgStartSeq = 0;
		packetsInMsg = 0;
	} else {
		seqThis = this.outSeq++;
	}

	var packet = {
		"created": Date.now(),
		"firstSent": 0,
		"sent": 0,
		"type": type,
		"seqThis": seqThis,
		"packetsInMsg": packetsInMsg,
		"msgStartSeq": msgStartSeq,
		"msgSize": msgSize,
		"payload": payload
	};

	if(seqThis == 0) {
		this.sendPacketOverWire(packet);
	} else {
		this.outPackets[seqThis] = packet;
		this.flushOutgoingBuffer();
	}
};

UDPConnection.prototype.handlePacket = function(packet) {
	this._resetTimeout();

	packet = ByteBuffer.wrap(packet, ByteBuffer.LITTLE_ENDIAN);

	if(packet.readString(MAGIC.length) != MAGIC) {
		this.emit('debug', "Got packet with invalid magic");
		return false;
	}

	var payloadSize = packet.readUint16();

	if(payloadSize > MAX_PAYLOAD) {
		this.emit('debug', "Got packet with big payload " + payloadSize + ", max " + MAX_PAYLOAD);
		return false;
	}

	var type = packet.readUint8();

	if(type <= EUdpPacketType.Invalid || type >= EUdpPacketType.Max) {
		this.emit('debug', "Got packet with invalid type " + type);
		return false;
	}

	var flags = packet.readUint8();
	var sourceConnID = packet.readUint32();

	if(this.remoteConnID > 0 && sourceConnID != this.remoteConnID) {
		this.emit('debug', "Got packet with invalid source conn ID (" + sourceConnID + ", expecting " + this.remoteConnID);
		return false;
	}

	if(this.remoteConnID == 0 && sourceConnID > 0) {
		this.remoteConnID = sourceConnID;
	}

	var remoteConnID = packet.readUint32();

	if(remoteConnID != this.sourceConnID) {
		this.emit('debug', "Got packet with invalid remote conn ID (" + remoteConnID + ", expecting " + this.sourceConnID);
		return false;
	}

	var seqThis = packet.readUint32();
	var seqAck = packet.readUint32();

	if(seqAck > this.outSeqAcked) {
		// They're acking something new
		this.outSeqAcked = seqAck;
		this.flushOutgoingBuffer(); // remove the stuff from our local buffer that they've acked
		this.flushIncomingBuffer(); // send anything that can now be sent due to acks
	}

	if(seqThis > 0 && seqThis <= this.inSeq) {
		// We already received this but the ack got lost. We'll re-ack in a bit.
		this.emit('debug', "Got packet " + seqThis + " type " + type + " that we already acked");
		this.queueAck();
		return false;
	}

	var packetsInMsg = packet.readUint32();
	var msgStartSeq = packet.readUint32();
	var msgSize = packet.readUint32();
	var payload = packet.slice().toBuffer();

	if(payload.length != payloadSize) {
		this.emit('debug', "Got packet with mismatching payload sizes, expecting " + payloadSize + ", got " + payload.length);
		return false;
	}

	this.emit('debug', "Rcvd seq " + seqThis + " ack " + seqAck + " type " + type + " flags " + flags + " payload " +
		payload.length + " msg packets " + packetsInMsg + " msg start " + msgStartSeq + " msg " + msgSize);

	if(type == EUdpPacketType.Datagram) {
		// We don't have any further processing to do on this, so don't add it to the buffer
		return true;
	}

	// Add this packet to our buffer
	this.inPackets[seqThis] = {
		"seqThis": seqThis,
		"type": type,
		"packetsInMsg": packetsInMsg,
		"msgStartSeq": msgStartSeq,
		"msgSize": msgSize,
		"payload": payload
	};

	this.flushIncomingBuffer();

	if (packetsInMsg > 3) {
		var numPacketInMsg = (seqThis - msgStartSeq) + 1;
		if (numPacketInMsg % 2 == 0) {
			// We want to ack multi-packet messages on every 2nd packet, to keep the stream coming steadily
			this.sendMessage(EUdpPacketType.Datagram);
		}
	}

	return true;
};

UDPConnection.prototype.queueAck = function() {
	if(this.ackTimeout) {
		return; // already queued
	}

	var self = this;
	this.ackTimeout = setTimeout(function() {
		self.ackTimeout = null;
		if(self.inSeqAcked < self.inSeq) {
			self.sendMessage(EUdpPacketType.Datagram);
		}
	}, 10);
};

UDPConnection.prototype.flushOutgoingBuffer = function() {
	// We store a copy of everything we send in our buffer, so if it gets lost we can resend it
	// Here we remove everything from our buffer that the other side has acked. We also (re)send messages here.

	var seqBuffer = getSeqBuffer(this.outPackets);
	var seqThis, packet, timeSinceSent;

	while(seqBuffer.length > 0) {
		seqThis = seqBuffer[0];

		if(seqThis <= this.outSeqAcked) {
			// This has been acked, so remove it from the local buffer
			delete this.outPackets[seqThis];
			seqBuffer.splice(0, 1);
			continue;
		}

		// This hasn't been acked.
		packet = this.outPackets[seqThis];

		if(!packet.firstSent) {
			// This has never been sent.
			if(this.outSeqSent >= (this.outSeqAcked + AHEAD_COUNT)) {
				// We can't send this yet since we haven't gotten an ack for enough previous packets.
				// This condition carries over to everything ahead of this, so we can break out of the loop now.
				break;
			}

			// We can safely send this
			this.sendPacketOverWire(packet);
			seqBuffer.splice(0, 1);
		} else {
			// This packet has been sent, but not acked yet.
			if(Date.now() - packet.firstSent >= (ACK_TIMEOUT * 1000)) {
				// This packet hasn't been acked in time. Assume connection is dead.
				this.emit('error', new Error("Connection timed out"));
				this.destroy();
				break;
			}

			if(Date.now() - packet.sent >= (RESEND_DELAY * 1000)) {
				// This packet hasn't been acked, but we can resend it.
				this.sendPacketOverWire(packet);
				seqBuffer.splice(0, 1);
			}

			// We can't do anything to this packet at this time
			seqBuffer.splice(0, 1);
		}
	}
};

UDPConnection.prototype.sendPacketOverWire = function(packet) {
	var header = new ByteBuffer(32 + MAGIC.length + packet.payload.length, ByteBuffer.LITTLE_ENDIAN);

	header.writeString(MAGIC); // magic
	header.writeUint16(packet.payload.length); // payload size
	header.writeUint8(packet.type); // packet type
	header.writeUint8(0); // flags
	header.writeUint32(this.sourceConnID); // source connection ID
	header.writeUint32(this.remoteConnID); // destination connection ID
	header.writeUint32(packet.seqThis); // this packet's sequence number
	header.writeUint32(this.inSeqAcked = this.inSeq); // the highest consecutive sequence number that we received from them
	header.writeUint32(packet.packetsInMsg); // number of packets in this message
	header.writeUint32(packet.msgStartSeq); // the sequence number in which this message started
	header.writeUint32(packet.msgSize); // the total size of this entire message
	header.append(packet.payload);

	var buffer = header.flip().toBuffer();
	this.socket.send(buffer, 0, buffer.length, this.remoteAddress.port, this.remoteAddress.address);

	this.emit('debug', "Send seq " + packet.seqThis + " ack " + this.inSeq + " type " + packet.type + " payload " +
		packet.payload.length + " msg packets " + packet.packetsInMsg + " msg start " + packet.msgStartSeq + " msg " + packet.msgSize);

	packet.firstSent = packet.firstSent || Date.now();
	packet.sent = Date.now();

	this.outSeqSent = Math.max(this.outSeqSent, packet.seqThis);

	if(this.ackTimeout) {
		// If we had an ack queued, cancel it since this is also acking
		clearTimeout(this.ackTimeout);
		this.ackTimeout = null;
	}
};

UDPConnection.prototype.flushIncomingBuffer = function() {
	// We store a copy of everything we receive in our buffer, so if something arrives out of order we can re-order it
	// Here we remove everything from our buffer that's valid and dispatch it

	// We don't ack anything until we receive it and everything that came before it

	var seqBuffer = getSeqBuffer(this.inPackets);

	var consecutive = seqBuffer.filter(function(seq, index) {
		if(index == 0 || seqBuffer[index - 1] == seq - 1) {
			return true;
		}
	});

	// Highest consecutive seq we've received is consecutive[consecutive.length - 1]
	if(this.inSeq < consecutive[consecutive.length - 1]) {
		this.inSeq = consecutive[consecutive.length - 1];
		this.queueAck();
	}

	var seqThis, packet, i, packets, payload;

	bufferDrainLoop:
	while(seqBuffer.length > 0) {
		seqThis = seqBuffer[0];

		if(seqThis <= this.inSeqHandled) {
			// We already handled this. We can't handle without acking so no need to re-ack.
			this.emit('debug', "Tried to handle a packet we already handled");
			delete this.inPackets[seqThis];
			seqBuffer.splice(0, 1);
			continue;
		}

		// No need to check if we already acked this since handlePacket does that

		if(seqThis == this.inSeq + 1) {
			// This is the next packet that they sent, so we can now ack it since we received everything before it
			this.inSeq = seqThis;
		}

		packet = this.inPackets[seqThis];

		if(packet.packetsInMsg > 0) {
			// Make sure this packet is where this message starts
			if(packet.msgStartSeq != seqThis) {
				// Something went wrong. We have to discard this.
				this.emit('debug', "Tried to handle a packet that wasn't the start of a message");
				delete this.inPackets[seqThis];
				seqBuffer.splice(0, 1);
				continue;
			}

			// Make sure we received every packet in this message
			packets = [];
			for(i = 0; i < packet.packetsInMsg; i++) {
				// Make sure this packet is in our sequence buffer
				if(seqBuffer[0] != seqThis + i) {
					// We don't have it yet, abort! Since everything is sequenced we can't process anything until we get this one.
					break bufferDrainLoop;
				}

				// The packet is in our buffer. Good.
				packets.push(this.inPackets[seqBuffer[0]]);
				seqBuffer.splice(0, 1);
			}

			// At this point we will either handle or discard all of these packets. Go ahead and remove them from our buffer.
			for(i = 0; i < packets.length; i++) {
				this.inSeqHandled = Math.max(this.inSeqHandled, packets[i].seqThis);
				delete this.inPackets[packets[i].seqThis];
			}

			// Sanity check to make sure all these packets correspond to the same message
			for(i = 1; i < packets.length; i++) {
				if(!packetsAreSameMsg(packets[0], packets[i])) {
					// Somthing went wrong. We must discard these.
					this.emit('debug', "Got a number of sequenced packets that don't correspond to the same message.");
					continue bufferDrainLoop;
				}
			}

			// At this point we know we have all the packets we need to reconstruct this message. So let's do it.
			payload = Buffer.concat(packets.map(function (packet) {
				return packet.payload;
			}));

			if(payload.length != packets[0].msgSize) {
				this.emit('debug', "Got a rebuilt message with mismatching size. Got " + payload.length + ", expected " + packets[0].msgSize);
				continue;
			}
		} else {
			packets = [packet];
			payload = packet.payload;

			seqBuffer.splice(0, 1);
			delete this.inPackets[seqThis];
		}

		this.handleMessage(packets[0].type, payload);
	}

	if(this.state == EConnectionState.Disconnecting && this.outSeqAcked >= this.outSeqSent) {
		this.destroy();
	}
};

UDPConnection.prototype.handleMessage = function(type, payload) {
	this.emit('debug', "Handling message type " + type);

	switch(type) {
		case EUdpPacketType.Challenge:
			if(this.state != EConnectionState.ChallengeReqSent) {
				this.emit('debug', "Got unexpected challenge, our state is " + this.state);
				return;
			}

			this.state = EConnectionState.ConnectSent;
			this.serverLoad = payload.readUInt32LE(4);
			this.sendMessage(EUdpPacketType.Connect, payload.readUInt32LE(0));
			break;

		case EUdpPacketType.Accept:
			if(this.state != EConnectionState.ConnectSent) {
				this.emit('debug', "Got unexpected accept, our state is " + this.state);
				return;
			}

			this.state = EConnectionState.Connected;
			this.flushInterval = setInterval(this.flushOutgoingBuffer.bind(this), 500);

			this.emit('connect', this.serverLoad);
			this.emit('debug', "Connected, server load " + this.serverLoad + ", remote connID " + this.remoteConnID);
			break;

		case EUdpPacketType.Data:
			if(this.state != EConnectionState.Connected) {
				this.emit('debug', "Got unexpected data, our state is " + this.state);
				return;
			}

			if(this.sessionKey) {
				try {
					payload = SteamCrypto.symmetricDecrypt(payload, this.sessionKey, this.useHmac);
				} catch (ex) {
					this.emit('encryptionError', ex);
					return;
				}
			}

			this.emit('packet', payload);
			break;

		case EUdpPacketType.Datagram:
			if(this.state != EConnectionState.Connected) {
				this.emit('debug', "Got unexpected datagram, our state is " + this.state);
				return;
			}

			break;

		case EUdpPacketType.Disconnect:
			if(this.state != EConnectionState.Connected && this.state != EConnectionState.Disconnecting) {
				this.emit('debug', "Got unexpected disconnect, our state is " + this.state);
				return;
			}

			// Ack it immediately
			this.sendMessage(EUdpPacketType.Datagram);
			this.destroy();
			break;

		default:
			this.emit('debug', "Tried to handle unknown packet type " + type);
	}
};

function packetsAreSameMsg(a, b) {
	return a.msgSize == b.msgSize && a.type == b.type && a.msgStartSeq == b.msgStartSeq && a.packetsInMsg == b.packetsInMsg;
}

function getSeqBuffer(buffer) {
	return Object.keys(buffer).map(function(seq) {
		return parseInt(seq, 10);
	}).sort(function(a, b) {
		if(a < b) {
			return -1;
		} else if(a > b) {
			return 1;
		}

		return 0;
	});
}
