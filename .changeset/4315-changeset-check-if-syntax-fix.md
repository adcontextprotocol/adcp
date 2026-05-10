---
---

ci(changeset-check): inline the multi-condition `if:` expression on one line. The previous block-scalar form (`if: |` with a multi-line `${{ ... }}` body) didn't evaluate as expected — GitHub Actions ran the job for `forward-merge/*` PRs anyway. One-line expression mirrors the working pattern elsewhere in the repo. Closes the regression introduced by #4315.
