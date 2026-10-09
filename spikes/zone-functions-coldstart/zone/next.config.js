/** Z2 spike zone. Same shape as the knext standalone fixture. */
module.exports = {
  output: 'standalone',
  typescript: { ignoreBuildErrors: true },
  generateBuildId: () => process.env.KNEXT_BUILD_ID || process.env.NEXT_DEPLOYMENT_ID || null,
};
