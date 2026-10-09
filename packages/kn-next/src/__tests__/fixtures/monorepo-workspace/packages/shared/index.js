// A workspace package that lives OUTSIDE the app directory. The app lists it
// in `serverExternalPackages`, so Next does not bundle it: it is loaded at
// runtime and must be traced into the standalone tree, which is exactly the
// "files outside the app dir" case a monorepo root exists to support.
module.exports = {
    greeting() {
        return "hello from the shared workspace package";
    },
};
