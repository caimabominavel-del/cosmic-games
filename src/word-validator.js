const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// PT-BR wordlist from public domain source
const WORDLIST_URL = 'https://raw.githubusercontent.com/pythonprobr/palavras/master/palavras.txt';

let wordSet = null;
let wordlistPath = null;

function setUserDataPath(userDataPath) {
  wordlistPath = path.join(userDataPath, 'wordlist-ptbr.txt');
}

function normalize(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function isLoaded() {
  return wordSet !== null && wordSet.size > 0;
}

function loadWordlist() {
  if (wordSet !== null) return isLoaded();
  if (!wordlistPath || !fs.existsSync(wordlistPath)) return false;

  try {
    const content = fs.readFileSync(wordlistPath, 'utf8');
    wordSet = new Set(content.split('\n').map(normalize).filter(w => w.length >= 2));
    console.log(`[WordValidator] Loaded ${wordSet.size} words`);
    return true;
  } catch (err) {
    console.error('[WordValidator] Failed to load wordlist:', err.message);
    wordSet = null;
    return false;
  }
}

function downloadWordlist() {
  return new Promise((resolve, reject) => {
    if (!wordlistPath) return reject(new Error('userData path not set'));

    // Already cached
    if (fs.existsSync(wordlistPath)) {
      loadWordlist();
      return resolve({ cached: true, count: wordSet ? wordSet.size : 0 });
    }

    console.log('[WordValidator] Downloading PT-BR wordlist...');

    const file = fs.createWriteStream(wordlistPath);
    const get = WORDLIST_URL.startsWith('https') ? https.get : http.get;

    const req = get(WORDLIST_URL, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        // Follow redirect
        file.close();
        fs.unlink(wordlistPath, () => {});
        const redirectUrl = response.headers.location;
        const redirGet = redirectUrl.startsWith('https') ? https.get : http.get;
        const redirFile = fs.createWriteStream(wordlistPath);
        redirGet(redirectUrl, (r2) => {
          r2.pipe(redirFile);
          redirFile.on('finish', () => {
            redirFile.close();
            loadWordlist();
            resolve({ cached: false, count: wordSet ? wordSet.size : 0 });
          });
        }).on('error', reject);
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        loadWordlist();
        resolve({ cached: false, count: wordSet ? wordSet.size : 0 });
      });
    });

    req.on('error', (err) => {
      fs.unlink(wordlistPath, () => {});
      reject(err);
    });

    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Download timed out'));
    });
  });
}

function validate(word, key) {
  if (!word || word.length < 2) {
    return { valid: false, reason: 'too_short' };
  }

  const normWord = normalize(word);
  const normKey = normalize(key);

  if (!normWord.includes(normKey)) {
    return { valid: false, reason: 'no_key' };
  }

  if (!isLoaded()) {
    // Offline mode: only check key presence
    return { valid: true, offline: true };
  }

  if (!wordSet.has(normWord)) {
    return { valid: false, reason: 'not_a_word' };
  }

  return { valid: true };
}

function getStatus() {
  return {
    loaded: isLoaded(),
    wordCount: wordSet ? wordSet.size : 0,
    path: wordlistPath
  };
}

module.exports = { setUserDataPath, downloadWordlist, loadWordlist, validate, getStatus };
