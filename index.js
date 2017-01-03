'use strict';
/* jshint node:true, esversion:6, latedef:nofunc */

var Steam = module.exports = require('steam-resources');

Steam._processProto = function(proto) {
	proto = proto.toRaw(false, true);
	(function deleteNulls(proto) {
		for (var field in proto) {
			if (!proto.hasOwnProperty(field)) {
				continue;
			}

			if (proto[field] == null) {
				delete proto[field];
			} else if (typeof proto[field] == 'object') {
				deleteNulls(proto[field]);
			}
		}
	})(proto);
	return proto;
};

/**
 * Protocols we can use to connect to a Steam CM.
 * @enum EConnectionProtocol
 */
Steam.EConnectionProtocol = {
	"TCP": 1,
	"UDP": 2
};

require('./lib/cm_client.js');
