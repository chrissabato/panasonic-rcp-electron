const { safeStorage } = require('electron');

const PREFIX = 'enc:';

/**
 * Encrypts camera passwords at rest with safeStorage (DPAPI on Windows).
 * Values without the prefix are read as plain text, so a database written
 * while encryption was unavailable still loads. Must be used after app ready.
 */
function createSecrets({ log = console.warn } = {}) {
    const available = safeStorage.isEncryptionAvailable();
    if (!available) {
        log('safeStorage encryption is unavailable; camera passwords will be stored as plain text');
    }

    return {
        encrypt(value) {
            if (!available || value === '') return value;
            return PREFIX + safeStorage.encryptString(value).toString('base64');
        },
        decrypt(stored) {
            if (!stored.startsWith(PREFIX)) return stored;
            return safeStorage.decryptString(Buffer.from(stored.slice(PREFIX.length), 'base64'));
        },
    };
}

module.exports = { createSecrets };
