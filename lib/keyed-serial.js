function createKeyedSerialExecutor() {
  const pendingByKey = new Map();

  async function run(key, task) {
    const normalizedKey = String(key || "");
    if (!normalizedKey) {
      return task();
    }

    const previous = pendingByKey.get(normalizedKey) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    pendingByKey.set(normalizedKey, current);

    try {
      return await current;
    } finally {
      if (pendingByKey.get(normalizedKey) === current) {
        pendingByKey.delete(normalizedKey);
      }
    }
  }

  function getPendingKeyCount() {
    return pendingByKey.size;
  }

  return {
    getPendingKeyCount,
    run,
  };
}

module.exports = {
  createKeyedSerialExecutor,
};
