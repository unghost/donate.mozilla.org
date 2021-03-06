var config = require('../intl-config.js');
var properties = require('properties-parser');
var write = require('fs-writefile-promise');
var path = require('path');
var FS = require("q-io/fs");
var Habitat = require('habitat');
Habitat.load();
var env = new Habitat();

var supportedLocales = env.get('SUPPORTED_LOCALES') || "*";

function getListLocales() {
  return new Promise(function(resolve, reject) {
    if (Array.isArray(supportedLocales)) {
      return resolve(supportedLocales);
    }
    FS.listDirectoryTree(path.join(process.cwd(), config.src)).then(function(dirTree) {
      var list = [];
      dirTree.forEach(function(i) {
        var that = i.split(config.src + '/');
        if (that[1]) {
          list.push(that[1]);
        }
      });
      return resolve(list);
    }).catch(function(e) {
      console.log(e);
      reject(e);
    });
  });
}

function writeFile(entries) {
  entries.reduce(function(prevEntry, entry) {
    write(path.join(process.cwd(), config.dest, entry.locale + '.json'), JSON.stringify(entry.content, null, 2), 'utf-8')
    .then(function(filename) {
      console.log('Done writing: ' + filename);
    }).catch(function(e) {
      console.log(e);
    });
  }, {});
}

function getContentMessages(locale) {
  return new Promise(function(resolve, reject) {
    properties.read(path.join(process.cwd(), config.src, locale, 'messages.properties'), function(error, properties) {
      if (error && error.code !== 'ENOENT') {
        return reject(error);
      }
      resolve({content: properties || {}, locale: locale});
    });
  });
}

function processMessageFiles(locales) {
  return Promise.all(locales.map(getContentMessages));
}

getListLocales().then(processMessageFiles)
.then(writeFile).catch(function(err) {
  console.error(err);
});
