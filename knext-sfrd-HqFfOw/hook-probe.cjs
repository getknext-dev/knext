
      'use strict';
      module.exports = (function (process, require) {
        const context = { fetch: async () => ({ status: 200 }) };
        const options = { moduleName: 'middleware' };
                    const __knextSfrd = (process.env.KNEXT_SANDBOX_FETCH_DEBUG === '1' && process.env.KNEXT_SANDBOX_FETCH_REALM_DEBUG_MODULE) ? (function () { try { return require(process.env.KNEXT_SANDBOX_FETCH_REALM_DEBUG_MODULE).acquire({ env: process.env, moduleName: options.moduleName }); } catch (e) { try { process.stderr.write('[sandbox-fetch-realm] acquire failed: ' + (e && e.message) + '\n'); } catch (_) {} return null; } })() : null; /* knext-sandbox-fetch-realm-debug */
            const __fetch = __knextSfrd ? __knextSfrd.wrapBaseFetch(context.fetch) : context.fetch; /* knext-sandbox-fetch-realm-debug */
            if (__knextSfrd) { context.fetch = __knextSfrd.wrapContextFetch(context.fetch); } /* knext-sandbox-fetch-realm-debug:outer */
        return { same: __fetch === context.fetch, sfrd: __knextSfrd };
      })(
        { env: {}, stderr: { write() {} } },
        () => { throw new Error('hook must not require when disabled'); },
      );
    