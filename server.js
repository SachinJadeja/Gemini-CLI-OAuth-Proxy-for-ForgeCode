import express from 'express';
import { createGeminiProvider } from 'ai-sdk-provider-gemini-cli';
import { generateText, streamText } from 'ai';

const app = express();
app.use(express.json({ limit: '50mb' }));

// Initialize the Gemini provider using OAuth credentials from ~/.gemini/oauth_creds.json
const gemini = createGeminiProvider({ authType: 'oauth-personal' });

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', provider: 'gemini-cli-oauth' });
});

// OpenAI-compatible model list endpoint
app.get('/v1/models', (_req, res) => {
  res.json({
    object: 'list',
    data: [
      {
        id: 'gemini-3.1-pro-preview',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'google',
      },
      {
        id: 'gemini-3-pro-preview',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'google',
      },
      {
        id: 'gemini-3-flash-preview',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'google',
      },
      {
        id: 'gemini-2.5-pro',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'google',
      },
      {
        id: 'gemini-2.5-flash',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'google',
      },
    ],
  });
});

/**
 * Map OpenAI tools format to AI SDK tools format
 * OpenAI: [{ type: 'function', function: { name, description, parameters } }]
 * AI SDK: { name: { description, parameters: zodSchema | jsonSchema } }
 */
function mapTools(openAiTools) {
  if (!openAiTools || !Array.isArray(openAiTools)) return undefined;
  const tools = {};
  for (const tool of openAiTools) {
    if (tool.type === 'function' && tool.function) {
      const { name, description, parameters } = tool.function;
      tools[name] = {
        description: description || '',
        parameters: parameters || { type: 'object', properties: {} },
      };
    }
  }
  return Object.keys(tools).length > 0 ? tools : undefined;
}

/**
 * Map OpenAI tool_choice to AI SDK toolChoice
 * OpenAI: 'auto' | 'none' | 'required' | { type: 'function', function: { name } }
 * AI SDK: 'auto' | 'none' | 'required' | { tool: string }
 */
function mapToolChoice(toolChoice) {
  if (!toolChoice) return undefined;
  if (toolChoice === 'auto') return 'auto';
  if (toolChoice === 'none') return 'none';
  if (toolChoice === 'required') return 'required';
  if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
    return { tool: toolChoice.function?.name };
  }
  return undefined;
}

/**
 * Map OpenAI messages to AI SDK format
 */
function mapMessages(messages) {
  return messages.map((msg) => {
    if (msg.role === 'tool') {
      return {
        role: 'user',
        content:
          typeof msg.content === 'string'
            ? `[Tool ${msg.name || 'tool'} result]\n${msg.content}`
            : `[Tool ${msg.name || 'tool'} result]\n${JSON.stringify(msg.content)}`,
      };
    }
    if (msg.role === 'assistant' && msg.tool_calls) {
      if (msg.content) {
        return {
          role: 'assistant',
          content: msg.content,
        };
      }

      return null;
    }
    return {
      role: msg.role,
      content: msg.content,
    };
  }).filter(Boolean);
}

/**
 * Map AI SDK tool calls to OpenAI format
 */
function mapToolCalls(toolCalls) {
  if (!toolCalls || toolCalls.length === 0) return undefined;
  return toolCalls.map((tc, idx) => ({
    id: tc.toolCallId || `call_${idx}`,
    type: 'function',
    function: {
      name: tc.toolName,
      arguments: JSON.stringify(tc.input || tc.args || {}),
    },
  }));
}

// OpenAI-compatible chat completions endpoint
app.post('/v1/chat/completions', async (req, res) => {
  const {
    messages,
    model = 'gemini-3.1-pro-preview',
    temperature,
    top_p,
    max_tokens,
    stop,
    stream: useStream = false,
    tools,
    tool_choice,
  } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({
      error: { message: 'messages array is required', type: 'invalid_request_error' },
    });
  }

  try {
    const modelInstance = gemini.languageModel(model);
    const sdkMessages = mapMessages(messages);
    const sdkTools = mapTools(tools);
    const sdkToolChoice = mapToolChoice(tool_choice);
    const stopSequences = Array.isArray(stop) ? stop : stop ? [stop] : undefined;

    if (useStream) {
      const result = streamText({
        model: modelInstance,
        messages: sdkMessages,
        temperature,
        topP: top_p,
        maxTokens: max_tokens,
        stopSequences,
        tools: sdkTools,
        toolChoice: sdkToolChoice,
      });

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const responseId = `gemini-${Date.now()}`;
      let hasSentRole = false;

      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-start': {
            if (!hasSentRole) {
              hasSentRole = true;
              res.write(`data: ${JSON.stringify({
                id: responseId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
              })}\n\n`);
            }
            break;
          }
          case 'text-delta': {
            res.write(`data: ${JSON.stringify({
              id: responseId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: { content: part.text }, finish_reason: null }],
            })}\n\n`);
            break;
          }
          case 'tool-call': {
            if (!hasSentRole) {
              hasSentRole = true;
              res.write(`data: ${JSON.stringify({
                id: responseId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
              })}\n\n`);
            }
            res.write(`data: ${JSON.stringify({
              id: responseId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: part.toolCallId,
                    type: 'function',
                    function: {
                      name: part.toolName,
                      arguments: JSON.stringify(part.input || part.args || {}),
                    },
                  }],
                },
                finish_reason: null,
              }],
            })}\n\n`);
            break;
          }
          case 'finish': {
            res.write(`data: ${JSON.stringify({
              id: responseId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: {}, finish_reason: mapFinishReason(part.finishReason) }],
            })}\n\n`);
            break;
          }
          case 'error': {
            console.error('Stream error:', part.error);
            res.write(`data: ${JSON.stringify({
              id: responseId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            })}\n\n`);
            break;
          }
        }
      }

      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      const result = await generateText({
        model: modelInstance,
        messages: sdkMessages,
        temperature,
        topP: top_p,
        maxTokens: max_tokens,
        stopSequences,
        tools: sdkTools,
        toolChoice: sdkToolChoice,
      });

      const responseId = `gemini-${Date.now()}`;
      const toolCalls = mapToolCalls(result.toolCalls);

      res.json({
        id: responseId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: result.text || '',
              ...(toolCalls && { tool_calls: toolCalls }),
            },
            finish_reason: mapFinishReason(result.finishReason),
          },
        ],
        usage: {
          prompt_tokens: result.usage?.inputTokens || 0,
          completion_tokens: result.usage?.outputTokens || 0,
          total_tokens: result.usage?.totalTokens || 0,
        },
      });
    }
  } catch (error) {
    console.error('Gemini proxy error:', error);
    // Extract the actual status code from nested AI SDK errors
    let statusCode = 500;
    let errorMessage = error?.message || 'Internal server error';
    let errorCode = error?.code || 'internal_error';

    if (error?.reason === 'maxRetriesExceeded' && error?.lastError) {
      const lastErr = error.lastError;
      errorMessage = lastErr?.message || errorMessage;
      if (lastErr?.statusCode) statusCode = lastErr.statusCode;
      if (lastErr?.data?.code) errorCode = lastErr.data.code;
    } else if (error?.statusCode) {
      statusCode = error.statusCode;
    }

    // Map Google's RESOURCE_EXHAUSTED to 429
    if (errorMessage?.includes('RESOURCE_EXHAUSTED') || errorMessage?.includes('rateLimitExceeded') || errorMessage?.includes('capacity')) {
      statusCode = 429;
      errorCode = 'rate_limit_exceeded';
    }

    res.status(statusCode).json({
      error: {
        message: errorMessage,
        type: error?.type || 'api_error',
        code: errorCode,
      },
    });
  }
});

function mapFinishReason(reason) {
  switch (reason) {
    case 'stop': return 'stop';
    case 'length': return 'length';
    case 'content-filter': return 'content_filter';
    case 'tool-calls': return 'tool_calls';
    default: return 'stop';
  }
}

const PORT = process.env.PORT || 4891;
app.listen(PORT, () => {
  console.log(`Gemini CLI OAuth proxy running on http://localhost:${PORT}`);
  console.log(`Endpoint: POST http://localhost:${PORT}/v1/chat/completions`);
  console.log(`Health:   GET  http://localhost:${PORT}/health`);
});
