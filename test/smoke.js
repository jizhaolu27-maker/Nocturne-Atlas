const suites = [
  require("./suites/context-knowledge"),
  require("./suites/memory-lifecycle"),
  require("./suites/platform-config"),
  require("./suites/retrieval"),
  require("./suites/proposals-provider"),
  require("./suites/story-state"),
  require("./suites/chat"),
  require("./suites/frontend"),
];

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  }
}

async function main() {
  for (const runSuite of suites) {
    await runSuite(runTest);
  }
  if (!process.exitCode) {
    console.log("Smoke tests completed successfully.");
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
