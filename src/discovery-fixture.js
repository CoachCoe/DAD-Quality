// Adapter-owned fixture swaps. No model text can choose a database or SQL command.
export async function replayFixture({ snapshot, restore, stop, start, inspect }) {
  await stop();
  let baseline;
  try {
    baseline = await snapshot();
  } finally {
    await start();
  }
  let busy = false;
  return {
    inspect,
    async replay() {
      if (busy) throw new Error('A fixture replay is already active.');
      busy = true;
      let current;
      try {
        await stop();
        current = await snapshot();
        await restore(baseline);
        await start();
      } catch (error) {
        try {
          if (current !== undefined) await restore(current);
          await start();
        } finally {
          busy = false;
        }
        throw error;
      }
      return async () => {
        try {
          await stop();
          await restore(current);
          await start();
        } finally {
          busy = false;
        }
      };
    },
  };
}
