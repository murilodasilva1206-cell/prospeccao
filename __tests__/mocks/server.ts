import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'

// Default OpenRouter mock — returns a valid search intent
export const handlers = [
  http.post('https://openrouter.ai/api/v1/chat/completions', () => {
    return HttpResponse.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              action: 'search',
              filters: { empresa: 'Acme' },
              confidence: 0.9,
            }),
          },
        },
      ],
    })
  }),
]

export const server = setupServer(...handlers)
