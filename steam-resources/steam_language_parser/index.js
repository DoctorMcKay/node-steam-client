var fs = require('fs');
var token_analyzer = require('./parser/token_analyzer');

var codeGen = require('./generator/node_gen');
var filePath = require('path').join(__dirname, '../steam_language/steammsg.steamd');

var tokenList = require('./parser/language_parser').tokenizeString(fs.readFileSync(filePath, { encoding: 'ascii' }));

var root = token_analyzer.analyze(tokenList);

var rootEnumNode = new token_analyzer.Node();
var rootMessageNode = new token_analyzer.Node();

rootEnumNode.childNodes = root.childNodes.filter( function(n) { return n instanceof token_analyzer.EnumNode; });
rootMessageNode.childNodes = root.childNodes.filter( function(n) { return n instanceof token_analyzer.ClassNode; });

require('./code_generator').emitCode(rootEnumNode, codeGen);
require('./code_generator').emitCode(rootMessageNode, codeGen);
