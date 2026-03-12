import { z } from 'zod'

/** UUID validator shared by all channel :id route params. */
export const ChannelIdSchema = z.string().uuid('id inválido')
