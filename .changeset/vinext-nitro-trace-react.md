---
"@getknext/core": patch
---

Pages that use `<style jsx>` now render on the vinext target instead of failing with an "Invalid hook call" error: the bundled vinext fixes make the Nitro build trace `react` and `react-dom`, so styled-jsx shares the server's single React copy (also after the `.output` directory is moved), on both the Node build and the compiled single executable.
