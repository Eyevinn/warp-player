module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Explicitly include some rules to avoid empty-rules error
    "type-enum": [
      2,
      "always",
      [
        "build",
        "chore",
        "ci",
        "docs",
        "feat",
        "fix",
        "perf",
        "refactor",
        "revert",
        "style",
        "test",
      ],
    ],
    "header-max-length": [2, "always", 120],
    "body-max-line-length": [2, "always", 120],
  },
};
