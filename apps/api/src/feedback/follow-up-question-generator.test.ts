import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AnthropicFollowUpQuestionGenerator,
  ConsoleFollowUpQuestionGenerator,
  createFollowUpQuestionGenerator,
} from './follow-up-question-generator';

describe('AnthropicFollowUpQuestionGenerator', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('sends the expected request shape to the Anthropic Messages API', async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'What made this great?' }] }), {
        status: 200,
      }),
    );

    const generator = new AnthropicFollowUpQuestionGenerator('test-api-key', 'claude-sonnet-5');
    await generator.generate({ rating: 5, comment: 'Loved it' });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(global.fetch).mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      'x-api-key': 'test-api-key',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    });

    const body = JSON.parse(init?.body as string);
    expect(body.model).toBe('claude-sonnet-5');
    expect(body.max_tokens).toBe(128);
    expect(body.messages).toEqual([{ role: 'user', content: expect.any(String) }]);
    expect(body.messages[0].content).toContain('5-star rating');
    expect(body.messages[0].content).toContain('Loved it');
  });

  it('uses "what went wrong" framing for a rating below 5', async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'What went wrong?' }] }), { status: 200 }),
    );

    const generator = new AnthropicFollowUpQuestionGenerator('test-api-key', 'claude-sonnet-5');
    await generator.generate({ rating: 2 });

    const [, init] = vi.mocked(global.fetch).mock.calls[0]!;
    const body = JSON.parse(init?.body as string);
    expect(body.messages[0].content).toContain('2-star');
    expect(body.messages[0].content).toContain('left no written comment');
  });

  it('returns the parsed question text on success', async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: 'text', text: '  What made it great?  ' }] }), {
        status: 200,
      }),
    );

    const generator = new AnthropicFollowUpQuestionGenerator('test-api-key', 'claude-sonnet-5');
    const result = await generator.generate({ rating: 5 });

    expect(result).toEqual({ question: 'What made it great?' });
  });

  it('throws when the API responds with a non-ok status', async () => {
    vi.mocked(global.fetch).mockResolvedValue(new Response('rate limited', { status: 429 }));

    const generator = new AnthropicFollowUpQuestionGenerator('test-api-key', 'claude-sonnet-5');
    await expect(generator.generate({ rating: 5 })).rejects.toThrow(
      'Anthropic API request failed with status 429',
    );
  });

  it('throws when the API returns no text content', async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(JSON.stringify({ content: [] }), { status: 200 }),
    );

    const generator = new AnthropicFollowUpQuestionGenerator('test-api-key', 'claude-sonnet-5');
    await expect(generator.generate({ rating: 5 })).rejects.toThrow(
      'Anthropic API returned no text content.',
    );
  });
});

describe('ConsoleFollowUpQuestionGenerator', () => {
  it('resolves without calling fetch', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    const generator = new ConsoleFollowUpQuestionGenerator();
    await generator.generate({ rating: 5 });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('returns the positive dev-mode question for a 5-star rating', async () => {
    const generator = new ConsoleFollowUpQuestionGenerator();
    const result = await generator.generate({ rating: 5 });
    expect(result.question).toContain('great');
  });

  it('returns the "what could be better" dev-mode question for a rating below 5', async () => {
    const generator = new ConsoleFollowUpQuestionGenerator();
    const result = await generator.generate({ rating: 3 });
    expect(result.question).toContain('better');
  });
});

describe('createFollowUpQuestionGenerator', () => {
  it('returns the Anthropic implementation in production', () => {
    const generator = createFollowUpQuestionGenerator('production', 'key', 'model');
    expect(generator).toBeInstanceOf(AnthropicFollowUpQuestionGenerator);
  });

  it('returns the Console fallback in development', () => {
    const generator = createFollowUpQuestionGenerator('development', 'key', 'model');
    expect(generator).toBeInstanceOf(ConsoleFollowUpQuestionGenerator);
  });

  it('returns the Console fallback in staging', () => {
    const generator = createFollowUpQuestionGenerator('staging', 'key', 'model');
    expect(generator).toBeInstanceOf(ConsoleFollowUpQuestionGenerator);
  });
});
