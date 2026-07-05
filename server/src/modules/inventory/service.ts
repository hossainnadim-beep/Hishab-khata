import type { Knex } from 'knex';
import { d, money, Decimal } from '../../lib/money.ts';
import { badRequest } from '../../lib/errors.ts';

/**
 * Weighted-average costing.
 * - Stock in (purchase/adjustment): new avg = (onHand×avg + inQty×unitCost) / (onHand + inQty).
 *   If stock was negative, the incoming cost simply becomes the new average.
 * - Stock out (sale): relieved at current average cost; negative stock is allowed
 *   and costed at the current average.
 * Rows are locked (FOR UPDATE) so concurrent documents serialize per item.
 */
export async function stockIn(
  trx: Knex,
  opts: { companyId: string; itemId: string; date: string; qty: string | number; unitCost: string | number; sourceType: string; sourceId?: string | null },
): Promise<void> {
  const item = await trx('items')
    .where({ id: opts.itemId, company_id: opts.companyId })
    .forUpdate()
    .first();
  if (!item) throw badRequest('Item not found');
  if (item.type !== 'inventory') return;

  const qty = d(opts.qty);
  const unitCost = d(opts.unitCost);
  if (qty.lte(0)) throw badRequest('Stock-in quantity must be positive');

  const onHand = d(item.qty_on_hand);
  const newQty = onHand.plus(qty);
  const newAvg = onHand.lte(0)
    ? unitCost
    : onHand.times(item.avg_cost).plus(qty.times(unitCost)).div(newQty);

  await trx('items').where({ id: item.id }).update({
    qty_on_hand: newQty.toFixed(4),
    avg_cost: newAvg.toDecimalPlaces(6).toFixed(6),
  });
  await trx('item_movements').insert({
    company_id: opts.companyId,
    item_id: item.id,
    movement_date: opts.date,
    qty_delta: qty.toFixed(4),
    unit_cost: unitCost.toDecimalPlaces(6).toFixed(6),
    source_type: opts.sourceType,
    source_id: opts.sourceId ?? null,
  });
}

/**
 * Returns the total cost (base currency, 2dp) for the units removed.
 * Default cost is the weighted average. `unitCostOverride` (vendor returns at
 * the documented credit price) removes at that cost and re-derives the average
 * of the remaining units so subledger value tracks the GL.
 */
export async function stockOut(
  trx: Knex,
  opts: { companyId: string; itemId: string; date: string; qty: string | number; sourceType: string; sourceId?: string | null; unitCostOverride?: string | number | Decimal },
): Promise<{ cogs: string; unitCost: string }> {
  const item = await trx('items')
    .where({ id: opts.itemId, company_id: opts.companyId })
    .forUpdate()
    .first();
  if (!item) throw badRequest('Item not found');
  if (item.type !== 'inventory') return { cogs: '0.00', unitCost: '0.000000' };

  const qty = d(opts.qty);
  if (qty.lte(0)) throw badRequest('Stock-out quantity must be positive');
  const avg = opts.unitCostOverride !== undefined ? d(opts.unitCostOverride) : d(item.avg_cost);
  const cogs = money(qty.times(avg));

  const newQty = d(item.qty_on_hand).minus(qty);
  const patch: Record<string, string> = { qty_on_hand: newQty.toFixed(4) };
  if (opts.unitCostOverride !== undefined) {
    const remainingValue = d(item.qty_on_hand).times(item.avg_cost).minus(qty.times(avg));
    patch.avg_cost = newQty.gt(0)
      ? Decimal.max(remainingValue.div(newQty), 0).toDecimalPlaces(6).toFixed(6)
      : '0.000000';
  }
  await trx('items').where({ id: item.id }).update(patch);
  await trx('item_movements').insert({
    company_id: opts.companyId,
    item_id: item.id,
    movement_date: opts.date,
    qty_delta: qty.negated().toFixed(4),
    unit_cost: avg.toFixed(6),
    source_type: opts.sourceType,
    source_id: opts.sourceId ?? null,
  });
  return { cogs, unitCost: avg.toFixed(6) };
}
