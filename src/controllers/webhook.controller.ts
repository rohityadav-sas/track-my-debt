import type { Request, Response } from 'express'
import bot from '../lib/bot.js'
import { registerUser } from './register.controller.js'
import {
  addDebt,
  changeHistoryPage,
  confirmSettle,
  getDebt,
  getHistory,
  settleDebt,
} from './debt.controller.js'
import { showHelp } from './help.controller.js'
import { format } from '../utils/format.js'
import { AppError } from '../utils/AppError.js'

const webhook = async (req: Request, res: Response) => {
  const callbackQuery = req.body.callback_query as Telegram.CallbackQuery
  if (callbackQuery && callbackQuery.data) {
    if (callbackQuery.data.startsWith('settle_')) {
      await confirmSettle(callbackQuery)
    }
    if (callbackQuery.data.startsWith('history:')) {
      await changeHistoryPage(callbackQuery)
    }
    return res.send()
  }
  try {
    const update = req.body.message as Telegram.Message
    if (update && update.text) {
      update.text = update.text?.replace(/@[\w]+_bot\b/, '').trim()
      switch (update.text) {
        case '/register':
          await registerUser(update)
          break
        case '/get':
          await getDebt(update)
          break
        case '/help':
          await showHelp(update)
          break
        case '/history':
          await getHistory(update)
          break
        default:
          if (update.text.startsWith('/add')) await addDebt(update)
          else if (update.text.startsWith('/settle')) await settleDebt(update)
          else
            await bot.sendMessage(
              update.chat.id,
              format.info(
                'Unknown Command',
                'Please use /help to see the list of available commands.'
              ),
              update.message_id
            )
          break
      }
    }
  } catch (err) {
    const isAppError = err instanceof AppError
    if (!isAppError) {
      console.error('Webhook error:', err)
    }
    await bot.sendMessage(
      req.body.message.chat.id,
      isAppError
        ? format.warning('Invalid Input', err.message)
        : format.error(
            'System Error',
            'An error occurred while processing your request. Please try again later.'
          ),
      req.body.message.message_id
    )
  } finally {
    res.send()
  }
}

export default webhook
