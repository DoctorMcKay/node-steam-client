// Update the CM list
require('http').get("http://api.steampowered.com/ISteamDirectory/GetCMList/v1/?format=json&cellid=0", function(res) {
	var data = '';
	res.on('data', function(chunk) {
		data += chunk;
	});

	res.on('end', function() {
		var json = JSON.parse(data);

		if (!json.response || json.response.result != 1) {
			// not fatal, client will get an updated list on connect anyway
			console.log("Cannot get current CM list");
		}

		var servers = json.response.serverlist.map(function (server) {
			var parts = server.split(':');
			return {
				"host": parts[0],
				"port": parseInt(parts[1], 10)
			};
		});

		require('fs').writeFileSync(__dirname + '/../resources/servers.json', JSON.stringify(servers, null, "\t"));
	});
});
