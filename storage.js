/**
 * A lightweight, promise-based wrapper for IndexedDB.
 * Designed to be a drop-in asynchronous replacement for localStorage limits.
 * © 2026 Joschua Gandert - License: Apache 2.0
 */
const Storage = (() => {
    const dbName = "one-storage";
    const storeName = "keyval";
    let dbPromise = null;

    const getDB = () => {
        if (dbPromise) {
            return dbPromise;
        }

        dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(dbName, 1);
            request.onupgradeneeded = () => {
                request.result.createObjectStore(storeName);
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        return dbPromise;
    };

    const withStore = async (mode, callback) => {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(storeName, mode);
            const store = transaction.objectStore(storeName);
            const request = callback(store);

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    };

    return {
        /**
         * Retrieve a value by key.
         * @param {string} key
         * @returns {Promise<any>}
         */
        get: (key) => withStore("readonly", (store) => store.get(key)),

        /**
         * Set a value by key.
         * @param {string} key
         * @param {any} value
         * @returns {Promise<void>}
         */
        set: (key, value) => withStore("readwrite", (store) => store.put(value, key)),

        /**
         * Remove a value by key.
         * @param {string} key
         * @returns {Promise<void>}
         */
        del: (key) => withStore("readwrite", (store) => store.delete(key)),

        /**
         * Clear all values in the store.
         * @returns {Promise<void>}
         */
        clear: () => withStore("readwrite", (store) => store.clear()),

        /**
         * Retrieve all keys in the store.
         * @returns {Promise<string[]>}
         */
        keys: () => withStore("readonly", (store) => store.getAllKeys()),
    };
})();
