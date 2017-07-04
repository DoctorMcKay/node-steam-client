var WS13 = require('websocket13');
var EventEmitter = require('events').EventEmitter;

module.exports = WebSocketConnection;

require('util').inherits(WebSocketConnection, EventEmitter);

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
function WebSocketConnection() {
	// We don't really need to set anything up here
}

WebSocketConnection.prototype.connect = function(options, callback) {
	this._ws = new WS13.WebSocket("wss://" + options.host + ":" + options.port + "/cmsocket/", {
		"pingInterval": 30000,
		"httpProxy": options.httpProxy,
		"proxyTimeout": options.proxyTimeout,
		"connection": {
			"localAddress": options.localAddress,
			"secureProtocol": "TLSv1_2_method"
		}
	});
	this._timeout = null;
	this._timeoutTime = 0;
	this._setupStream();
	callback();
};

WebSocketConnection.prototype._setupStream = function() {
	var self = this;
	this._ws.on('debug', function() { self.emit.apply(self, ['debug'].concat(Array.prototype.slice.call(arguments))) });
	this._ws.on('disconnected', function(code, reason) {
		self.emit('debug', 'WebSocket disconnected with code ' + code + ' and reason: ' + reason);
		self.emit.apply(self, ['close'].concat(Array.prototype.slice.call(arguments)));
		self.emit.apply(self, ['end'].concat(Array.prototype.slice.call(arguments))); 
	});
	this._ws.on('error', function(err) {
		self.emit('debug', 'WebSocket disconnected with error: ' + err.message);
		self.emit.apply(self, ['error'].concat(Array.prototype.slice.call(arguments)));
		self.emit.apply(self, ['close'].concat(Array.prototype.slice.call(arguments)));
		self.emit.apply(self, ['end'].concat(Array.prototype.slice.call(arguments)));
	});
	this._ws.on('connected', function() { self.emit.apply(self, ['connect'].concat(Array.prototype.slice.call(arguments))); });
	this._ws.on('message', self._readPacket.bind(self));
};

WebSocketConnection.prototype.setTimeout = function(ms) {
	if (!ms) {
		clearTimeout(this._timeout);
		this._timeout = null;
		this._timeoutTime = null;
	} else {
		clearTimeout(this._timeout);
		this._timeoutTime = ms;
		this._timeout = setTimeout(() => {
			this.emit('timeout');
			this.setTimeout(this._timeoutTime);
		});
	}
};

WebSocketConnection.prototype._resetTimeout = function() {
	if (!this._timeout) {
		return;
	}

	this.setTimeout(this._timeoutTime);
};

WebSocketConnection.prototype.end = function() {
	if (this._ws && [WS13.State.Connected, WS13.State.Connecting].indexOf(this._ws.state) != -1) {
		this._ws.disconnect();
	}
};

WebSocketConnection.prototype.destroy = function() {
	if (this._ws && [WS13.State.Connected, WS13.State.Connecting].indexOf(this._ws.state) != -1) {
		this._ws.disconnect();
	}
};

/**
 * Send data over the connection.
 * @param {Buffer} data
 */
WebSocketConnection.prototype.send = function(data) {
	this._ws.send(data);
};

WebSocketConnection.prototype._readPacket = function(type, packet) {
	if (type != WS13.FrameType.Data.Binary) {
		this.emit('debug', 'Got frame with wrong data type: ' + type);
		return;
	}

	this.emit('packet', packet);
};
