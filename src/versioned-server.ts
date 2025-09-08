#!/usr/bin/env node

import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import { createV1Server } from './server-v1.js';
import { createV2Server } from './server-v2.js';
import { randomUUID } from 'node:crypto';

dotenv.config();

interface VersionedTransport {
  transport: SSEServerTransport;
  version: 'v1' | 'v2';
}

export async function runVersionedSSECloudServer() {
  const transports: { [sessionId: string]: VersionedTransport } = {};
  const httpTransports: {
    [sessionId: string]: {
      transport: StreamableHTTPServerTransport;
      version: 'v1' | 'v2';
      apiKey: string;
    };
  } = {};
  const app = express();

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'OK',
      versions: ['v1', 'v2'],
      endpoints: {
        v1: {
          sse: '/{apiKey}/sse',
          messages: '/{apiKey}/messages',
        },
        v2: {
          sse: '/{apiKey}/v2/sse',
          messages: '/{apiKey}/v2/messages',
        },
      },
    });
  });

  // Create server instances
  const v1Server = createV1Server();
  const v2Server = createV2Server();

  // V1 SSE endpoint (legacy)
  app.get('/:apiKey/sse', async (req, res) => {
    const apiKey = req.params.apiKey;

    const transport = new SSEServerTransport(`/${apiKey}/messages`, res);

    console.log(`[V1] New SSE connection for API key: ${apiKey}`);

    const compositeKey = `${apiKey}-${transport.sessionId}`;
    transports[compositeKey] = { transport, version: 'v1' };

    res.on('close', () => {
      console.log(`[V1] SSE connection closed for: ${compositeKey}`);
      delete transports[compositeKey];
    });

    await v1Server.connect(transport);
  });

  // V1 SSE HEAD for quick availability checks
  app.head('/:apiKey/sse', (req, res) => {
    res.status(200).end();
  });

  // V2 SSE endpoint (new)
  app.get('/:apiKey/v2/sse', async (req, res) => {
    const apiKey = req.params.apiKey;

    const transport = new SSEServerTransport(`/${apiKey}/v2/messages`, res);

    console.log(`[V2] New SSE connection for API key: ${apiKey}`);

    const compositeKey = `${apiKey}-${transport.sessionId}`;
    transports[compositeKey] = { transport, version: 'v2' };

    res.on('close', () => {
      console.log(`[V2] SSE connection closed for: ${compositeKey}`);
      delete transports[compositeKey];
    });

    await v2Server.connect(transport);
  });

  // V2 SSE HEAD for quick availability checks
  app.head('/:apiKey/v2/sse', (req, res) => {
    res.status(200).end();
  });

  // V1 message endpoint (legacy)
  app.post(
    '/:apiKey/messages',
    express.json(),
    async (req: Request, res: Response) => {
      const apiKey = req.params.apiKey;
      const body = req.body;

      // Enrich the body with API key metadata
      const enrichedBody = {
        ...body,
      };

      if (enrichedBody && enrichedBody.params && !enrichedBody.params._meta) {
        enrichedBody.params._meta = { apiKey };
      } else if (
        enrichedBody &&
        enrichedBody.params &&
        enrichedBody.params._meta
      ) {
        enrichedBody.params._meta.apiKey = apiKey;
      }

      console.log(`[V1] Message received for API key: ${apiKey}`);

      // Prefer explicit sessionId from query, then common header names
      const rawSessionId =
        (req.query.sessionId as string) ||
        (req.headers['mcp-session-id'] as string) ||
        (req.headers['x-mcp-session-id'] as string) ||
        '';

      let compositeKey = `${apiKey}-${rawSessionId}`;
      let versionedTransport = transports[compositeKey];

      // Fallback: if not found, and there is exactly one active V1 transport for this apiKey, use it
      if (!versionedTransport) {
        const candidates = Object.entries(transports).filter(
          ([key, vt]) => vt.version === 'v1' && key.startsWith(`${apiKey}-`)
        );
        if (candidates.length === 1) {
          const [fallbackKey, vt] = candidates[0];
          console.warn(
            `[V1] sessionId not provided or not found. Falling back to single active transport: ${fallbackKey}`
          );
          compositeKey = fallbackKey;
          versionedTransport = vt;
        }
      }

      if (versionedTransport && versionedTransport.version === 'v1') {
        await versionedTransport.transport.handlePostMessage(
          req,
          res,
          enrichedBody
        );
      } else {
        console.error(`[V1] No transport found for sessionId: ${compositeKey}`);
        res.status(400).json({
          error: 'No V1 transport found for sessionId',
        });
      }
    }
  );

  // V2 message endpoint (new)
  app.post(
    '/:apiKey/v2/messages',
    express.json(),
    async (req: Request, res: Response) => {
      const apiKey = req.params.apiKey;
      const body = req.body;

      // Enrich the body with API key metadata
      const enrichedBody = {
        ...body,
      };

      if (enrichedBody && enrichedBody.params && !enrichedBody.params._meta) {
        enrichedBody.params._meta = { apiKey };
      } else if (
        enrichedBody &&
        enrichedBody.params &&
        enrichedBody.params._meta
      ) {
        enrichedBody.params._meta.apiKey = apiKey;
      }

      console.log(`[V2] Message received for API key: ${apiKey}`);

      const sessionId = req.query.sessionId as string;
      const compositeKey = `${apiKey}-${sessionId}`;
      const versionedTransport = transports[compositeKey];

      if (versionedTransport && versionedTransport.version === 'v2') {
        await versionedTransport.transport.handlePostMessage(
          req,
          res,
          enrichedBody
        );
      } else {
        console.error(`[V2] No transport found for sessionId: ${compositeKey}`);
        res.status(400).json({
          error: 'No V2 transport found for sessionId',
        });
      }
    }
  );

  // V1 Streamable HTTP MCP endpoint
  app.all(
    '/:apiKey/v1/mcp',
    express.json(),
    async (req: Request, res: Response) => {
      const apiKey = req.params.apiKey;
      const body: any = req.body;

      // Enrich body with apiKey metadata
      if (body && body.params) {
        if (!body.params._meta) body.params._meta = { apiKey };
        else body.params._meta.apiKey = apiKey;
      }

      try {
        // Reuse existing transport if sessionId provided
        const existingSessionId =
          (req.query.sessionId as string) ||
          (req.headers['mcp-session-id'] as string) ||
          (req.headers['x-mcp-session-id'] as string) ||
          '';

        if (existingSessionId) {
          console.log(
            `[V1][HTTP] Incoming ${req.method} for session ${existingSessionId}`
          );
        }

        if (
          existingSessionId &&
          httpTransports[existingSessionId] &&
          httpTransports[existingSessionId].version === 'v1' &&
          httpTransports[existingSessionId].apiKey === apiKey
        ) {
          await httpTransports[existingSessionId].transport.handleRequest(
            req,
            res,
            body
          );
          return;
        }

        // Create new streamable transport on initialize
        if (body && body.method === 'initialize') {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid: string) => {
              httpTransports[sid] = { transport, version: 'v1', apiKey };
              console.log(`[V1][HTTP] Initialized session ${sid}`);
            },
          });

          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid && httpTransports[sid]) delete httpTransports[sid];
          };

          await v1Server.connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        }

        // No session found and not initialize
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Invalid or missing session ID' },
          id: body?.id ?? null,
        });
      } catch (error) {
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: body?.id ?? null,
          });
        }
      }
    }
  );

  // V2 Streamable HTTP MCP endpoint
  app.all(
    '/:apiKey/v2/mcp',
    express.json(),
    async (req: Request, res: Response) => {
      const apiKey = req.params.apiKey;
      const body: any = req.body;

      // Enrich body with apiKey metadata
      if (body && body.params) {
        if (!body.params._meta) body.params._meta = { apiKey };
        else body.params._meta.apiKey = apiKey;
      }

      try {
        // Reuse existing transport if sessionId provided
        const existingSessionId =
          (req.query.sessionId as string) ||
          (req.headers['mcp-session-id'] as string) ||
          (req.headers['x-mcp-session-id'] as string) ||
          '';

        if (existingSessionId) {
          console.log(
            `[V2][HTTP] Incoming ${req.method} for session ${existingSessionId}`
          );
        }

        if (
          existingSessionId &&
          httpTransports[existingSessionId] &&
          httpTransports[existingSessionId].version === 'v2' &&
          httpTransports[existingSessionId].apiKey === apiKey
        ) {
          await httpTransports[existingSessionId].transport.handleRequest(
            req,
            res,
            body
          );
          return;
        }

        // Create new streamable transport on initialize
        if (body && body.method === 'initialize') {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid: string) => {
              httpTransports[sid] = { transport, version: 'v2', apiKey };
              console.log(`[V2][HTTP] Initialized session ${sid}`);
            },
          });

          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid && httpTransports[sid]) delete httpTransports[sid];
          };

          await v2Server.connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        }

        // No session found and not initialize
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Invalid or missing session ID' },
          id: body?.id ?? null,
        });
      } catch (error) {
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: body?.id ?? null,
          });
        }
      }
    }
  );

  // Catch-all for unsupported endpoints
  app.use((req, res) => {
    res.status(404).json({
      error: 'Endpoint not found',
      supportedEndpoints: {
        health: '/health',
        v1: {
          sse: '/:apiKey/sse',
          messages: '/:apiKey/messages',
        },
        v2: {
          sse: '/:apiKey/v2/sse',
          messages: '/:apiKey/v2/messages',
        },
      },
    });
  });

  const PORT = process.env.PORT || 3000;

  const server = app.listen(PORT, () => {
    console.log(
      `🚀 Versioned MCP SSE Server listening on http://localhost:${PORT}`
    );
    console.log('📋 Available endpoints:');
    console.log(`   Health: http://localhost:${PORT}/health`);
    console.log(`   V1 SSE: http://localhost:${PORT}/{apiKey}/sse`);
    console.log(`   V1 Messages: http://localhost:${PORT}/{apiKey}/messages`);
    console.log(`   V2 SSE: http://localhost:${PORT}/{apiKey}/v2/sse`);
    console.log(
      `   V2 Messages: http://localhost:${PORT}/{apiKey}/v2/messages`
    );
    console.log(
      `   V1 Streamable MCP: http://localhost:${PORT}/{apiKey}/v1/mcp`
    );
    console.log(
      `   V2 Streamable MCP: http://localhost:${PORT}/{apiKey}/v2/mcp`
    );
    console.log('');
    console.log('🔧 Versions:');
    console.log(
      '   V1: Firecrawl JS 1.29.3 (legacy tools + deep research + llms.txt)'
    );
    console.log('   V2: Firecrawl JS 3.1.0 (modern API + JSON extraction)');
  });

  // Tune server timeouts for long-lived requests
  const keepAliveMs = Number(process.env.KEEP_ALIVE_TIMEOUT_MS) || 620000; // ~10m20s
  const headersTimeoutMs =
    Number(process.env.HEADERS_TIMEOUT_MS) || keepAliveMs + 10000;
  const requestTimeoutMs =
    process.env.REQUEST_TIMEOUT_MS !== undefined
      ? Number(process.env.REQUEST_TIMEOUT_MS)
      : 0; // 0 disables request timeout
  server.keepAliveTimeout = keepAliveMs;
  server.headersTimeout = headersTimeoutMs;
  server.requestTimeout = requestTimeoutMs;
  // Older Node property
  server.timeout = requestTimeoutMs;

  server.on('error', (error: any) => {
    console.error('❌ Server error:', error);
    if (error.code === 'EADDRINUSE') {
      console.error(
        `❌ Port ${PORT} is already in use. Please use a different port.`
      );
    }
    process.exit(1);
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server...');
    console.log(`📊 Active connections: ${Object.keys(transports).length}`);

    // Close all transports
    for (const [key, versionedTransport] of Object.entries(transports)) {
      try {
        console.log(
          `🔌 Closing transport: ${key} (${versionedTransport.version})`
        );
        // Note: SSEServerTransport doesn't have a close method, connections will close naturally
        delete transports[key];
      } catch (error) {
        console.error(`❌ Error closing transport ${key}:`, error);
      }
    }

    console.log('✅ Server shutdown complete');
    process.exit(0);
  });
}

// Start the server if this file is run directly
// if (import.meta.url === `file://${process.argv[1]}`) {
//   runVersionedSSECloudServer().catch(console.error);
// }
