import { createReadStream } from "node:fs";
import net from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";

export function registerNode() {
    console.log(
        "[devfix] node instrumentation",
        typeof net,
        typeof tls,
        typeof zlib,
        typeof createReadStream,
    );
}
