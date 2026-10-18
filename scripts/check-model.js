import { discoveryProvider } from '../src/discovery.js';
import { requireModelConfig } from '../src/model-provider.js';
import { redact } from '../src/core.js';

try {
  const config = requireModelConfig();
  const decide = discoveryProvider(config);
  const decision = await decide({
    observation: {
      text: 'No application is connected. This is a model connection check. Choose finish with a brief reason.',
      controls: [],
      path: '/',
    },
    history: [],
    investigations: [],
    memory: [],
    remaining: { requests: 1, tokens: 2000 },
    signal: AbortSignal.timeout(60_000),
  });
  console.log(
    `Connected: ${config.providerName} / ${config.model}. Validated one tool action; ${decision.tokens} tokens used. No application was started.`,
  );
} catch (error) {
  console.error(redact(error.message));
  process.exitCode = 2;
}
