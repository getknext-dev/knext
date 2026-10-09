// Generates buffa messages + connect-rust service stubs from a precompiled
// FileDescriptorSet (`buf build ../proto --as-file-descriptor-set -o ping.binpb`),
// so the image build needs neither protoc nor buf.
fn main() {
    println!("cargo:rerun-if-changed=ping.binpb");
    connectrpc_build::Config::new()
        .descriptor_set("ping.binpb")
        .files(&["zonefn/v1/ping.proto"])
        .include_file("_connectrpc.rs")
        .compile()
        .unwrap();
}
