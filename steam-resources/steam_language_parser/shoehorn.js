// This file shoehorns SteamKit's .steamd files to fit the parser's format.

var FS = require('fs');
FS.readdirSync(__dirname + '/../steam_language').forEach(function(filename) {
	if (!filename.match(/\.steamd$/)) {
		return;
	}
	
	var file = FS.readFileSync(__dirname + '/../steam_language/' + filename).toString('ascii');
	file = file.replace(/; removed/g, '; obsolete').replace(/\> removed/g, '>');
	FS.writeFileSync(__dirname + '/../steam_language/' + filename, file);
});
