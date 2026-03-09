import { setCacheHandler } from "vinext/shims/cache";
import CacheHandler from "./cache-handler.js";

export default function () {
    console.log("[Nitro Plugin] Registering Vinext CacheHandler...");
    setCacheHandler(new CacheHandler());
}
