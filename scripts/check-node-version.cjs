const REQUIRED_MAJOR = 24;

const currentVersion = process.versions.node;
const currentMajor = Number.parseInt(currentVersion.split(".")[0], 10);

if (currentMajor !== REQUIRED_MAJOR) {
  console.error(
    [
      `Unsupported Node.js version ${currentVersion}.`,
      `This project supports the latest LTS release only: Node ${REQUIRED_MAJOR}.x.`,
      "Switch Node versions and try again."
    ].join("\n")
  );

  process.exit(1);
}
