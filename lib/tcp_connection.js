var SteamCrypto = require('@doctormckay/steam-crypto');
var Socket = require('net').Socket;
var HTTP = require('http');
var URL = require('url');

module.exports = TCPConnection;

const MAGIC = 'VT01';

require('util').inherits(TCPConnection, require('events').EventEmitter);

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
 */

/**
 * @constructor
 */
function TCPConnection() {
	// We don't really need to set anything up here
}

TCPConnection.prototype.connect = function(options, callback) {
	if (options.httpProxy) {
		var self = this;
		var url = URL.parse(options.httpProxy);
		url.method = 'CONNECT';
		url.path = options.host + ':' + options.port;
		url.localAddress = options.localAddress;
		url.localPort = options.localPort;

		if (url.auth) {
			url.headers = {"Proxy-Authorization": "Basic " + (new Buffer(url.auth, 'utf8')).toString('base64')};
			delete url.auth;
		}

		var connectionEstablished = false;

		var req = this._request = HTTP.request(url);
		req.end();
		req.setTimeout(options.proxyTimeout || 5000);

		req.on('connect', function(res, socket) {
			if (connectionEstablished) {
				socket.end();
				return;
			}

			connectionEstablished = true;
			req.setTimeout(0);

			if (res.statusCode != 200) {
				callback(new Error("HTTP CONNECT " + res.statusCode + " " + res.statusMessage));
				return;
			}

			self._stream = socket;
			self._setupStream();
			callback();
			self.emit('connect');
		});

		req.on('timeout', function() {
			connectionEstablished = true;
			callback(new Error("Proxy connection timed out"));
		});

		req.on('error', function() {
			if (!connectionEstablished) {
				callback.apply(self, Array.prototype.slice.call(arguments));
				return;
			}

			self.emit.apply(self, ['error'].concat(Array.prototype.slice.call(arguments)));
			connectionEstablished = true;
		});
	} else {
		this._stream = new Socket();
		this._setupStream();
		callback();
		this._stream.connect(options);
	}
};

TCPConnection.prototype._setupStream = function() {
	var self = this;
	this._stream.on('readable', this._readPacket.bind(this));
	this._stream.on('close', function() { self.emit.apply(self, ['close'].concat(Array.prototype.slice.call(arguments))); });
	this._stream.on('error', function() { self.emit.apply(self, ['error'].concat(Array.prototype.slice.call(arguments))); });
	this._stream.on('connect', function() { self.emit.apply(self, ['connect'].concat(Array.prototype.slice.call(arguments))); });
	this._stream.on('end', function() { self.emit.apply(self, ['end'].concat(Array.prototype.slice.call(arguments))); });
	this._stream.on('timeout', function() { self.emit.apply(self, ['timeout'].concat(Array.prototype.slice.call(arguments))); });
	this.setTimeout = this._stream.setTimeout.bind(this._stream);
};

TCPConnection.prototype.end = function() {
	if (this._stream) {
		this._stream.end();
	}

	if (this._request) {
		this._request.abort();
	}
};

TCPConnection.prototype.destroy = function() {
	if (this._stream) {
		this._stream.destroy();
	}
};

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
	this._stream.write(buffer);
};

TCPConnection.prototype._readPacket = function() {
	if (!this._packetLen) {
		var header = this._stream.read(8);
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

	var packet = this._stream.read(this._packetLen);

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
