---
"@getknext/core": patch
---

The GitHub Action no longer pastes its inputs into the deploy script, so a branch name or other outside text passed as `tag` can no longer run as a command in your CI job. **If you pass a raw branch name as `tag`, it now fails when it contains a `/`**, because that is not a valid image tag: use the commit SHA (the default) or replace the slash. `tag` and `bucket` are checked against the shapes an image tag and a bucket name can take, and an invalid value stops the step with a message that names the rule. The action also runs a pinned CLI release instead of whatever `latest` is on the day: the new `cli-version` input holds an exact version such as `1.3.1`, and ranges or tags like `latest` are refused.
