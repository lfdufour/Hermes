/**
 * workflow/runner.js — Headless workflow runner for Iris.
 *
 * Executes a workflow (array of nodes) against a shared context object,
 * using the provided engine, protocol, registry, and trace services.
 *
 * The default chat (input -> llm with agentLoop -> output) is just one
 * workflow; the runner is generic and supports branching, looping, and
 * direct tool invocations.
 *
 * Exports: runWorkflow
 */

import { runAgent } from '../agent/loop.js';

/** Safety cap for loop iterations to prevent infinite loops. */
const MAX_LOOP_ITERATIONS = 25;

/**
 * Resolve template arguments: replace string values that reference context
 * variables (prefixed with '$') with the actual context value.
 * Non-string values and strings without '$' prefix pass through unchanged.
 *
 * @param {object} args - raw argument object from the node
 * @param {object} context - the workflow context bag
 * @returns {object} resolved arguments
 */
function resolveArgs(args, context) {
  if (!args || typeof args !== 'object') return {};
  const resolved = {};
  for (const [key, val] of Object.entries(args)) {
    if (typeof val === 'string' && val.startsWith('$')) {
      // Dereference from context
      resolved[key] = context[val.slice(1)];
    } else {
      resolved[key] = val;
    }
  }
  return resolved;
}

/**
 * Execute a sequence of workflow nodes.
 *
 * @param {object[]} nodes - array of workflow node objects
 * @param {object} services - { engine, protocol, registry, trace, context }
 * @returns {Promise<object>} the (mutated) context
 */
async function executeNodes(nodes, services) {
  const { engine, protocol, registry, trace, context } = services;

  for (const node of nodes) {
    switch (node.type) {
      case 'input': {
        // The caller must pre-seed context[node.as]. We just verify it exists.
        if (!(node.as in context)) {
          throw new Error(`Workflow input: context["${node.as}"] was not pre-seeded`);
        }
        break;
      }

      case 'llm': {
        // Build messages from context
        const messages = [];

        // Optional system message
        if (node.system || context.__system) {
          messages.push({
            role: 'system',
            content: node.system || context.__system,
          });
        }

        // The input variable becomes a user message
        const inputVar = node.in;
        if (inputVar && context[inputVar] !== undefined) {
          messages.push({
            role: 'user',
            content: String(context[inputVar]),
          });
        }

        // Append prior messages if the context carries a conversation history
        if (context.__messages && Array.isArray(context.__messages)) {
          // NOTE: If the context has __messages, they take precedence and the
          // input var is assumed to already be part of them. This allows the
          // chat UI to pass the full conversation history.
          messages.length = 0;
          messages.push(...context.__messages);
        }

        const genConfig = node.genConfig || {};
        const thinking = node.thinking ?? true;

        if (node.agentLoop) {
          // Use the full agent loop (tool-using generation loop)
          const result = await runAgent({
            engine,
            protocol,
            registry,
            messages,
            genConfig,
            thinking,
            trace,
            maxSteps: node.maxSteps,
          });
          context[node.out] = result.finalText;
          // Also stash the messages for downstream use
          context.__messages = result.messages;
        } else {
          // Single shot: applyChatTemplate -> generate
          const flatSpecs = node.tools === '*' ? registry.list() :
                            node.tools ? registry.list().filter(t => node.tools.includes(t.name)) :
                            [];
          const toolSpecs = protocol.toolSpecsToTemplate(flatSpecs);

          const shaped = protocol.buildMessagesForPrompt(messages, { thinking });
          const { input_ids } = await engine.applyChatTemplate({
            messages: shaped,
            tools: toolSpecs,
            thinking,
          });

          const { outputText } = await engine.generate({
            input_ids,
            genConfig,
            onToken: () => {}, // no-op for single-shot
          });

          const { content } = protocol.splitFinal(outputText);
          context[node.out] = content;
        }
        break;
      }

      case 'tool': {
        const args = resolveArgs(node.args, context);
        const result = await registry.invoke(node.name, args);
        context[node.out] = result.value;
        break;
      }

      case 'condition': {
        const varValue = context[node.var];
        let conditionMet = false;

        switch (node.op) {
          case '==':
            conditionMet = varValue === node.value;
            break;
          case '!=':
            conditionMet = varValue !== node.value;
            break;
          case 'truthy':
            conditionMet = !!varValue;
            break;
          case 'falsy':
            conditionMet = !varValue;
            break;
          default:
            throw new Error(`Condition: unknown op "${node.op}"`);
        }

        const branch = conditionMet ? node.then : (node.else || []);
        if (branch.length > 0) {
          await executeNodes(branch, services);
        }
        break;
      }

      case 'loop': {
        const iterations = node.times !== undefined
          ? Math.min(node.times, MAX_LOOP_ITERATIONS)
          : MAX_LOOP_ITERATIONS; // whileVar mode uses this as a safety cap

        for (let i = 0; i < iterations; i++) {
          // For whileVar mode, check the condition before each iteration
          if (node.whileVar !== undefined && !context[node.whileVar]) {
            break;
          }

          // Expose the iteration index in context for the body to use
          context.__loopIndex = i;

          await executeNodes(node.body, services);
        }

        // Clean up loop index
        delete context.__loopIndex;
        break;
      }

      case 'output': {
        context.__output = context[node.from];
        break;
      }

      default:
        throw new Error(`Unknown node type: "${node.type}"`);
    }
  }

  return context;
}

/**
 * Run a complete workflow.
 *
 * @param {object[]} workflow - array of workflow nodes
 * @param {object} opts
 * @param {EngineClient} opts.engine   - RPC client wrapping the model worker
 * @param {object}       opts.protocol - gemma.js: buildMessagesForPrompt, createStreamParser, splitFinal
 * @param {ToolRegistry} opts.registry - tool registry
 * @param {TraceBus}     opts.trace    - trace event bus
 * @param {object}       [opts.context={}] - initial context (variable bag); caller pre-seeds input vars here
 * @returns {Promise<object>} the final context (with __output set by output nodes)
 */
export async function runWorkflow(workflow, { engine, protocol, registry, trace, context = {} }) {
  return executeNodes(workflow, { engine, protocol, registry, trace, context });
}
