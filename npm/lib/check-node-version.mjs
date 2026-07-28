const minimum = { major: 22, minor: 19 };
const [major = 0, minor = 0] = process.versions.node
  .split(".")
  .map((value) => Number.parseInt(value, 10));

if (major < minimum.major || (major === minimum.major && minor < minimum.minor)) {
  process.stderr.write(
    `MyPi requires Node.js ${minimum.major}.${minimum.minor} or newer. Active Node.js: ${process.versions.node}. Upgrade Node.js, then run the install again.\n`,
  );
  process.exit(1);
}
