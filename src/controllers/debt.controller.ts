import bot from '../lib/bot.js'
import connectDB from '../lib/mongodb.js'
import { validateAddDebt, validateSettleDebt } from '../utils/validation.js'
import {
  createDebt,
  getDebts,
  getDebtSummary,
  getDebtBetweenUsers,
} from '../services/debt.service.js'
import {
  getUserByTelegramId,
  getUserByUsername,
} from '../services/user.service.js'
import mongoose from 'mongoose'
import { format, getDisplayName, sendProcessingMessage } from '../utils/format.js'



const HISTORY_PAGE_SIZE = 15

const getHistoryPage = async (user: IUser, chatId: number, page: number) => {
  const currentPage = Math.max(1, page)
  const skip = (currentPage - 1) * HISTORY_PAGE_SIZE
  const debts = await getDebts(
    user._id,
    chatId,
    HISTORY_PAGE_SIZE + 1,
    skip
  )
  const hasNextPage = debts.length > HISTORY_PAGE_SIZE
  const pageDebts = debts.slice(0, HISTORY_PAGE_SIZE)

  if (pageDebts.length === 0) {
    return {
      text: format.info('No History', 'No debt history found.'),
      options: undefined,
    }
  }

  const message = pageDebts
    .map((debt, idx) => {
      const isAuthor = debt.author._id === user._id
      const partner = isAuthor ? debt.partner : debt.author
      const name = getDisplayName(partner)
      const displayAmount = isAuthor ? debt.amount : -debt.amount
      const sign = displayAmount > 0 ? '+' : ''
      const symbol =
        displayAmount === 0
          ? format.icons.neutral
          : displayAmount > 0
            ? format.icons.positive
            : format.icons.negative
      const date = debt.createdAt
        ? new Date(debt.createdAt)
          .toLocaleDateString('en-GB', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
          })
          .replace(/ /g, '-')
        : 'N/A'

      return (
        `${skip + idx + 1}. ${symbol} ${format.bold(name)} -> ${format.code(
          sign + displayAmount
        )}\n` + `   ${format.italic(debt.description)} | ${date}`
      )
    })
    .join('\n\n')

  const buttons = []
  if (currentPage > 1) {
    buttons.push({
      text: 'Previous',
      callback_data: `history:${user._id}:${currentPage - 1}`,
    })
  }
  if (hasNextPage) {
    buttons.push({
      text: 'Next',
      callback_data: `history:${user._id}:${currentPage + 1}`,
    })
  }

  return {
    text:
      format.bold(`${format.icons.history} Debt History`) +
      ` ${format.italic(`Page ${currentPage}`)}` +
      '\n\n' +
      message,
    options: buttons.length
      ? {
        reply_markup: {
          inline_keyboard: [buttons],
        },
      }
      : undefined,
  }
}


const addDebt = async (update: Telegram.Message) => {
  const chatId = update.chat.id
  const { id } = update.from
  const { users, amount, description } = validateAddDebt(
    update.text,
    update.entities
  )
  const msgId = await sendProcessingMessage(update.chat.id, update.message_id)
  await connectDB()
  const author = await getUserByTelegramId([id])
  if (author.length === 0) {
    return await bot.editMessage(
      chatId,
      msgId,
      format.warning(
        'Not Registered',
        'You are not registered. Use /register to use the bot.'
      )
    )
  }

  const [usersByTelegramId, usersByUsername] = await Promise.all([
    getUserByTelegramId(users.ids.map((u) => u.id)),
    getUserByUsername(users.usernames),
  ])

  const foundTelegramIds = new Set(usersByTelegramId.map((u) => u._id))
  const foundUsernames = new Set(usersByUsername.map((u) => u.username))

  const notFoundTelegramIds = users.ids.filter(
    (u) => !foundTelegramIds.has(u.id)
  )
  const notFoundUsernames = users.usernames.filter(
    (u) => !foundUsernames.has(u)
  )

  if (notFoundTelegramIds.length || notFoundUsernames.length) {
    const missingNames = [
      ...notFoundTelegramIds.map((u) => u.first_name),
      ...notFoundUsernames,
    ].join(', ')
    return await bot.editMessage(
      chatId,
      msgId,
      format.warning(
        'Users Not Found',
        `The following users are not registered: ${format.bold(
          missingNames
        )} \nTell them to register using /register command`
      )
    )
  }

  const partners = [...usersByTelegramId, ...usersByUsername]
  if (partners.some((p) => p._id === id)) {
    return await bot.editMessage(
      chatId,
      msgId,
      format.warning('Invalid Operation', 'You cannot add debt to yourself.')
    )
  }

  const session = await mongoose.startSession()

  try {
    await session.withTransaction(async () => {
      for (const partner of partners) {
        await createDebt(
          {
            group: chatId,
            author: author[0]._id,
            partner: partner._id,
            amount: amount,
            description,
            createdAt: new Date(),
          },
          session
        )
      }
    })
  } finally {
    session.endSession()
  }
  const formattedPartners = partners.map((p) => getDisplayName(p)).join(', ')

  return await bot.editMessage(
    chatId,
    msgId,
    format.success(
      'Debt Added',
      `Debt added successfully to ${format.bold(formattedPartners)} \n
${format.listItem(`Amount: ${format.bold(amount.toString())}`)}
${format.listItem(`Description: ${format.italic(description)}`)}`
    )
  )
}

const getDebt = async (update: Telegram.Message) => {
  const msgId = await sendProcessingMessage(update.chat.id, update.message_id)
  await connectDB()
  const author = await getUserByTelegramId([update.from.id])
  if (author.length === 0) {
    return await bot.editMessage(
      update.chat.id,
      msgId,
      format.warning(
        'Not Registered',
        'You are not registered. Use /register to use the bot.'
      )
    )
  }

  const debtSummary = await getDebtSummary(author[0]._id, update.chat.id)

  if (debtSummary.length === 0) {
    return await bot.editMessage(
      update.chat.id,
      msgId,
      format.info('No Debts', 'No debts found in this group.')
    )
  }

  const message = debtSummary
    .map((debt) => {
      const name = getDisplayName(debt.partner)
      const amount = debt.amount
      const sign = amount > 0 ? '+' : ''
      const symbol =
        amount === 0
          ? format.icons.neutral
          : amount > 0
            ? format.icons.positive
            : format.icons.negative
      return `${symbol} ${format.bold(name)} → ${format.code(
        sign + amount.toString()
      )}`
    })
    .join('\n')

  const totalDebt = debtSummary.reduce((acc, debt) => acc + debt.amount, 0)
  const sign = totalDebt > 0 ? '+' : ''
  const symbol =
    totalDebt === 0
      ? format.icons.neutral
      : totalDebt > 0
        ? format.icons.positive
        : format.icons.negative
  await bot.editMessage(
    update.chat.id,
    msgId,
    format.bold(`${format.icons.debt} Debt Summary`) +
    '\n\n' +
    message +
    '\n\n' +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `${symbol} <b>Total:</b> ${format.code(sign + totalDebt.toString())}`
  )
}
const getHistory = async (update: Telegram.Message) => {
  const msgId = await sendProcessingMessage(update.chat.id, update.message_id)
  await connectDB()
  const author = await getUserByTelegramId([update.from.id])
  if (author.length === 0) {
    return await bot.editMessage(
      update.chat.id,
      msgId,
      format.warning(
        'Not Registered',
        'You are not registered. Use /register to use the bot.'
      )
    )
  }
  const historyPage = await getHistoryPage(author[0], update.chat.id, 1)
  return await bot.editMessage(
    update.chat.id,
    msgId,
    historyPage.text,
    historyPage.options
  )
}

const changeHistoryPage = async (callbackQuery: Telegram.CallbackQuery) => {
  if (!callbackQuery.data || !callbackQuery.message) return

  const [, ownerIdStr, pageStr] = callbackQuery.data.split(':')
  const ownerId = Number(ownerIdStr)
  const page = Number(pageStr)

  if (!Number.isInteger(ownerId) || !Number.isInteger(page) || page < 1) {
    return await bot.answerCallbackQuery(
      callbackQuery.id,
      'Invalid history page.'
    )
  }

  if (callbackQuery.from.id !== ownerId) {
    return await bot.answerCallbackQuery(
      callbackQuery.id,
      'Only the user who opened this history can change pages.'
    )
  }

  await connectDB()
  const [author] = await getUserByTelegramId([ownerId])
  if (!author) {
    return await bot.answerCallbackQuery(
      callbackQuery.id,
      'Please register before using history.'
    )
  }

  const historyPage = await getHistoryPage(
    author,
    callbackQuery.message.chat.id,
    page
  )
  await bot.editMessage(
    callbackQuery.message.chat.id,
    callbackQuery.message.message_id,
    historyPage.text,
    historyPage.options
  )
  await bot.answerCallbackQuery(callbackQuery.id)
}

const settleDebt = async (update: Telegram.Message) => {
  const msgId = await sendProcessingMessage(update.chat.id, update.message_id)
  const result = validateSettleDebt(update.text, update.entities)

  if (!result) return
  const { userId, username } = result

  await connectDB()
  const [author, partner] = await Promise.all([
    getUserByTelegramId([update.from.id]),
    username ? getUserByUsername([username]) : getUserByTelegramId([userId]),
  ])
  if (author.length === 0) {
    return await bot.editMessage(
      update.chat.id,
      msgId,
      format.warning(
        'Not Registered',
        'You are not registered. Use /register to use the bot.'
      )
    )
  }

  if (partner.length === 0) {
    return await bot.editMessage(
      update.chat.id,
      msgId,
      format.warning(
        'User Not Found',
        `${format.bold(
          `@${username}` || 'The mentioned user'
        )} is not registered. Tell them to register using /register command`
      )
    )
  }

  if (partner[0]._id === author[0]._id) {
    return await bot.editMessage(
      update.chat.id,
      msgId,
      format.warning('Invalid Operation', 'You cannot settle debt with yourself.')
    )
  }

  const existingDebt = await getDebtBetweenUsers(
    author[0]._id,
    partner[0]._id,
    update.chat.id
  )

  if (existingDebt === 0) {
    return await bot.editMessage(
      update.chat.id,
      msgId,
      format.info(
        'Already Settled',
        'Debts are already settled or no debts exist between you two in this group.'
      )
    )
  }

  // await bot.sendMessage(
  //   update.chat.id,
  //   format.warning(
  //     'Settlement Request',
  //     `━━━━━━━━━━━━━━━━━━━━\n\n` +
  //     `${format.bold(
  //       getDisplayName(author[0])
  //     )} wants to settle debts with ${format.bold(
  //       getDisplayName(partner[0])
  //     )}.\n\n` +
  //     `${format.italic(
  //       `${getDisplayName(partner[0])}, please confirm this settlement.`
  //     )}`
  //   ),
  //   update.message_id,
  //   {
  //     reply_markup: {
  //       inline_keyboard: [
  //         [
  //           {
  //             text: '✅ Confirm',
  //             callback_data: `settle_confirm:${author[0]._id}_${partner[0]._id}`,
  //           },
  //           {
  //             text: '❌ Cancel',
  //             callback_data: `settle_cancel:${author[0]._id}_${partner[0]._id}`,
  //           },
  //         ],
  //       ],
  //     },
  //   }
  // )
  return await bot.editMessage(
    update.chat.id,
    msgId,
    format.info(
      'Settlement Request',
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `${format.bold(
        getDisplayName(author[0])
      )} wants to settle debts with ${format.bold(
        getDisplayName(partner[0])
      )}.\n\n` +
      `${format.italic(
        `${getDisplayName(partner[0])}, please confirm this settlement.`
      )}`
    ),
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '✅ Confirm',
              callback_data: `settle_confirm:${author[0]._id}_${partner[0]._id}`,
            },
            {
              text: '❌ Cancel',
              callback_data: `settle_cancel:${author[0]._id}_${partner[0]._id}`,
            },
          ],
        ]
      }
    }
  )
}

const confirmSettle = async (callbackQuery: Telegram.CallbackQuery) => {
  if (!callbackQuery.data) return console.error('No data in callback query')
  const [action, ids] = callbackQuery.data.split(':')
  const [authorIdStr, partnerIdStr] = ids.split('_')
  await connectDB()
  const [author] = await getUserByTelegramId([Number(authorIdStr)])
  const [partner] = await getUserByTelegramId([Number(partnerIdStr)])
  if (action === 'settle_cancel') {
    const isAuthor = callbackQuery.from.id.toString() === authorIdStr
    const isPartner = callbackQuery.from.id.toString() === partnerIdStr
    if (!isAuthor && !isPartner) {
      return await bot.answerCallbackQuery(
        callbackQuery.id,
        'You are not authorized for this action.'
      )
    }
    await bot.answerCallbackQuery(callbackQuery.id, 'Settlement cancelled.')

    return await bot.editMessage(
      callbackQuery.message.chat.id,
      callbackQuery.message.message_id,
      format.warning(
        'Settlement Cancelled',
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `The settlement request has been cancelled by ${format.bold(
          getDisplayName(isAuthor ? author : partner)
        )}.`
      )
    )
  }
  if (action !== 'settle_confirm')
    return console.error('Invalid action in callback query')

  if (callbackQuery.from.id !== partner._id) {
    const displayName = getDisplayName(partner)
    return await bot.answerCallbackQuery(
      callbackQuery.id,
      `Only ${displayName} can confirm this settlement.`
    )
  }

  const session = await mongoose.startSession()

  try {
    await session.withTransaction(async () => {
      const chatId = callbackQuery.message.chat.id
      const existingAmount = await getDebtBetweenUsers(
        author._id,
        partner._id,
        chatId
      )

      if (existingAmount === 0) {
        return await bot.sendMessage(
          chatId,
          format.info(
            'Already Settled',
            'Debts are already settled or no debts exist between you two in this group.'
          ),
          callbackQuery.message.message_id
        )
      }

      await createDebt(
        {
          group: chatId,
          author: author._id,
          partner: partner._id,
          amount: -existingAmount,
          description: 'Settlement',
        },
        session
      )

      await bot.editMessage(
        callbackQuery.message.chat.id,
        callbackQuery.message.message_id,
        format.success(
          'Settlement Completed',
          `━━━━━━━━━━━━━━━━━━━━\n\n` +
          `Debts between ${format.bold(
            getDisplayName(author)
          )} and ${format.bold(
            getDisplayName(partner)
          )} have been settled successfully.`
        )
      )
    })
  } catch (err) {
    console.error('Error during settlement transaction:', err.message || err)
    await bot.sendMessage(
      callbackQuery.message.chat.id,
      format.error(
        'System Error',
        'An error occurred while processing the settlement. Please try again later.'
      ),
      callbackQuery.message.message_id
    )
  } finally {
    session.endSession()
    await bot.answerCallbackQuery(callbackQuery.id)
  }
}

export {
  addDebt,
  getDebt,
  getHistory,
  changeHistoryPage,
  settleDebt,
  confirmSettle,
}
