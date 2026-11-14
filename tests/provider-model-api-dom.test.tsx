// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  post: vi.fn(async (_path: string, _body: unknown) => ({})),
  patch: vi.fn(async (_path: string, _body: unknown) => ({})),
}));
vi.mock('../web/src/api/client', () => ({
  api: {
    post: mocks.post,
    patch: mocks.patch,
    get: vi.fn(),
    put: vi.fn(),
  },
}));
import { ProviderEditor } from '../web/src/components/settings/ProviderEditor';

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  mocks.post.mockClear();
  mocks.patch.mockClear();
});

function findButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  return button!;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  );
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

test('creates an OpenAI-compatible provider without appending [1m] and sets EVOBOT_MODEL_API', async () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);

  await act(async () =>
    root!.render(
      <ProviderEditor
        open
        provider={null}
        onSave={() => {}}
        onCancel={() => {}}
        setNotice={() => {}}
        setError={() => {}}
      />,
    ),
  );

  await act(async () => findButton('OpenAI 兼容').click());
  expect(findButton('OpenAI 兼容').getAttribute('aria-pressed')).toBe('true');

  const urlInput = document.querySelector<HTMLInputElement>('input[type="url"]')!;
  const passwordInput = document.querySelector<HTMLInputElement>(
    'input[type="password"]',
  )!;
  const textInputs = [
    ...document.querySelectorAll<HTMLInputElement>('input[type="text"]'),
  ];
  const nameInput = textInputs[0];
  const modelInput = textInputs[1];

  await act(async () => {
    setInputValue(nameInput, 'OpenAI Relay');
    setInputValue(urlInput, 'https://api.openai.com/v1');
    setInputValue(passwordInput, 'sk-test-1234');
    setInputValue(modelInput, 'gpt-4o');
  });

  await act(async () => findButton('创建').click());

  expect(mocks.post).toHaveBeenCalledWith(
    '/api/config/claude/providers',
    expect.objectContaining({
      name: 'OpenAI Relay',
      type: 'third_party',
      anthropicBaseUrl: 'https://api.openai.com/v1',
      anthropicAuthToken: 'sk-test-1234',
      anthropicModel: 'gpt-4o',
      customEnv: expect.objectContaining({
        EVOBOT_MODEL_API: 'openai-completions',
      }),
    }),
  );
});

test('edits an OpenAI-compatible provider back to Anthropic protocol cleanly', async () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);

  await act(async () =>
    root!.render(
      <ProviderEditor
        open
        provider={
          {
            id: 'openai-1',
            name: 'OpenAI Relay',
            type: 'third_party',
            anthropicBaseUrl: 'https://api.openai.com/v1',
            anthropicModel: 'gpt-4o',
            customEnv: {
              EVOBOT_MODEL_API: 'openai-completions',
            },
            hasAnthropicAuthToken: true,
            health: null,
          } as any
        }
        onSave={() => {}}
        onCancel={() => {}}
        setNotice={() => {}}
        setError={() => {}}
      />,
    ),
  );

  expect(findButton('OpenAI 兼容').getAttribute('aria-pressed')).toBe('true');
  await act(async () => findButton('Anthropic 兼容').click());
  await act(async () => findButton('保存').click());

  const patchBody = mocks.patch.mock.calls[0]?.[1] as {
    customEnv: Record<string, string>;
  };
  expect(patchBody.customEnv).not.toHaveProperty('EVOBOT_MODEL_API');
});
