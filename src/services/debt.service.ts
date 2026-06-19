import { ClientSession } from 'mongoose'
import Debt from '../models/debt.model.js'

export const createDebt = async (debtData: IDebt, session?: ClientSession) =>
  Debt.create([debtData], { session })

export const getDebts = async (
  userId: number,
  chatId: number,
  limit?: number,
  skip?: number
) =>
  Debt.find({ $or: [{ author: userId }, { partner: userId }], group: chatId })
    .populate<{ author: IUser; partner: IUser }>('author partner')
    .sort({ createdAt: -1 })
    .skip(skip ?? 0)
    .limit(limit ?? 0)
    .lean()

export const getDebtSummary = async (userId: number, chatId: number) => {
  const debts = await Debt.find({
    $or: [{ author: userId }, { partner: userId }],
    group: chatId,
  })
    .populate<{ author: IUser; partner: IUser }>('author partner')
    .lean()

  const summaryMap = new Map<number, { partner: IUser; amount: number }>()

  for (const debt of debts) {
    const isAuthor = debt.author._id === userId
    const partner = isAuthor ? debt.partner : debt.author
    const amount = isAuthor ? debt.amount : -debt.amount

    const existing = summaryMap.get(partner._id)
    if (existing) {
      existing.amount += amount
    } else {
      summaryMap.set(partner._id, { partner, amount })
    }
  }

  return Array.from(summaryMap.values())
}

export const getDebtBetweenUsers = async (
  authorId: number,
  partnerId: number,
  chatId: number
): Promise<number> => {
  const debts = await Debt.find({
    $or: [
      { author: authorId, partner: partnerId },
      { author: partnerId, partner: authorId },
    ],
    group: chatId,
  }).lean()

  let totalAmount = 0
  for (const debt of debts) {
    if (debt.author === authorId) {
      totalAmount += debt.amount
    } else {
      totalAmount -= debt.amount
    }
  }

  return totalAmount
}
