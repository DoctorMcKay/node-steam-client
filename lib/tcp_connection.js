'use strict';
/* jshint node:true, esversion:6, latedef:nofunc */

var SteamCrypto = require('@doctormckay/steam-crypto');
var Socket = require('net').Socket;

module.exports = TCPConnection;

const MAGIC = 'VT01';

require('util').inherits(TCPConnection, Socket);

/**
 * @augments Socket
 * @constructor
 */
function TCPConnection() {
	Socket.call(this);
	this.on('readable', this._readPacket.bind(this));
}

/**
 * Send data over the connection.
 * @param {Buffer} data
 */
TCPConnection.prototype.send = function(data) {
	// encrypt
	if (this.sessionKey) {
		if (this.useHmac) {
			data = SteamCrypto.symmetricEncryptWithHmacIv(data, this.sessionKey);
		} else {
			data = SteamCrypto.symmetricEncrypt(data, this.sessionKey);
		}
	}

	var buffer = new Buffer(4 + 4 + data.length);
	buffer.writeUInt32LE(data.length, 0);
	buffer.write(MAGIC, 4);
	data.copy(buffer, 8);
	this.write(buffer);
};

TCPConnection.prototype._readPacket = function() {
	if (!this._packetLen) {
		var header = this.read(8);
		if (!header) {
			return;
		}
		this._packetLen = header.readUInt32LE(0);
		if (header.slice(4).toString('ascii') != MAGIC) {
			this.emit('error', new Error('Bad magic'));
			this.end();
			return;
		}
	}

	var packet = this.read(this._packetLen);

	if (!packet) {
		this.emit('debug', 'incomplete packet');
		return;
	}

	delete this._packetLen;

	// decrypt
	if (this.sessionKey) {
		try {
			packet = SteamCrypto.symmetricDecrypt(packet, this.sessionKey, this.useHmac);
		} catch (ex) {
			this.emit('encryptionError', ex);
			return;
		}
	}

	this.emit('packet', packet);

	// keep reading until there's nothing left
	this._readPacket();
};
