import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** Guard against a new delivery path bypassing provider policy. Internal callers
 * and isolated evaluation are intentionally outside this surface inventory. */
describe('User-facing response policy boundary', () => {
  it.each([
    ['server/src/addie/bolt-app.ts', 'slack', 7],
    ['server/src/addie/email-conversation-handler.ts', 'email', 1],
    ['server/src/mcp/chat-tool.ts', 'mcp', 1],
    ['server/src/routes/tavus.ts', 'tavus', 1],
  ] as const)('all response dispatches in %s cross the global policy', (path, surface, count) => {
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const dispatches: ts.CallExpression[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ['processMessage', 'processMessageStream'].includes(node.expression.name.text)) dispatches.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(dispatches).toHaveLength(count);
    for (const call of dispatches) {
      const receiver = (call.expression as ts.PropertyAccessExpression).expression;
      expect(ts.isCallExpression(receiver)).toBe(true);
      if (!ts.isCallExpression(receiver)) continue;
      expect(receiver.expression.getText(source)).toBe('responseClient');
      expect(receiver.arguments[1].getText(source)).toBe(`'${surface}'`);
    }
    if (surface === 'slack') {
      // Covers assistant DM streaming and its non-streaming path, mentions,
      // direct messages, thread continuations, proposed channel replies, reactions.
      expect(dispatches.map(call => {
        let parent: ts.Node | undefined = call;
        while (parent && !ts.isFunctionDeclaration(parent)) parent = parent.parent;
        return parent?.name?.getText(source);
      })).toEqual([
        'handleUserMessage', 'handleUserMessage', 'handleAppMention',
        'handleDirectMessage', 'handleActiveThreadReply', 'handleChannelMessage', 'handleReactionAdded',
      ]);
    }
  });
});
