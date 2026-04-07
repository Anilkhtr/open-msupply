import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLazyQuery, useMutation, useQuery } from "@apollo/client";
import { v4 as uuid } from "uuid";
import BackButton from "../../components/BackButton";
import { useAuth } from "../../hooks/useAuth";
import { PREF_KEYS, useAppPreferences } from "../../hooks/useAppPreferences";
import {
  DAILY_TALLY_ITEMS,
  FINALISE_STOCKTAKE,
  INSERT_PRESCRIPTION,
  INSERT_STOCKTAKE,
  SAVE_PRESCRIPTION_ITEM_LINES,
  STOCK_LINES_FOR_ITEM,
  STOCKTAKE_LINES,
  UPDATE_PRESCRIPTION,
  UPDATE_STOCKTAKE_LINE,
} from "../../api/graphql/operations";

type Gender = "Female" | "Male" | "Other";

type AgeGroup = "0-11 months" | "1-4 years" | "5-14 years" | "15+ years";

interface TallyBreakdown {
  id: string;
  gender: Gender;
  ageGroup: AgeGroup;
  issuedQty: number;
}

interface TallyItem {
  id: string;
  itemName: string;
  code: string;
  units: string;
  isVaccine: boolean;
  dosesPerVial: number | null;
  stockOnHand: number;
  administeredQty: number;
  hasOpenVialWastage: boolean;
  wastageQty: number;
  wastageAutoSuggested: boolean;
  details: TallyBreakdown[];
}

interface CatalogItem {
  id: string;
  itemName: string;
  code: string;
  units: string;
  isVaccine: boolean;
  dosesPerVial: number | null;
  stockOnHand: number;
}

interface DraftBreakdown {
  gender: Gender;
  ageGroup: AgeGroup;
  issuedQty: string;
}

const genderOptions: Gender[] = ["Female", "Male", "Other"];
const ageGroupOptions: AgeGroup[] = [
  "0-11 months",
  "1-4 years",
  "5-14 years",
  "15+ years",
];

export default function DailyTallyScreen() {
  const navigate = useNavigate();
  const { storeId } = useAuth();
  const prefs = useAppPreferences();
  const [items, setItems] = useState<TallyItem[]>([]);
  const [itemFilter, setItemFilter] = useState("");
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftBreakdown>({
    gender: "Female",
    ageGroup: "0-11 months",
    issuedQty: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [detailBreakdownEnabled, setDetailBreakdownEnabled] = useState(false);

  const [insertPrescription] = useMutation(INSERT_PRESCRIPTION);
  const [savePrescriptionLines] = useMutation(SAVE_PRESCRIPTION_ITEM_LINES);
  const [updatePrescription] = useMutation(UPDATE_PRESCRIPTION);
  const [stockLinesQuery] = useLazyQuery(STOCK_LINES_FOR_ITEM);

  const [insertStocktake] = useMutation(INSERT_STOCKTAKE);
  const [fetchStocktakeLines] = useLazyQuery(STOCKTAKE_LINES);
  const [updateStocktakeLine] = useMutation(UPDATE_STOCKTAKE_LINE);
  const [finaliseStocktake] = useMutation(FINALISE_STOCKTAKE);

  const { data: itemsData, loading: loadingItems, error: itemsLoadError } = useQuery(
    DAILY_TALLY_ITEMS,
    {
      variables: { storeId: storeId! },
      skip: !storeId,
      fetchPolicy: "network-only",
    }
  );

  useEffect(() => {
    const nodes = itemsData?.items?.nodes ?? [];
    if (nodes.length === 0) {
      setItems([]);
      return;
    }

    const catalogItems: CatalogItem[] = nodes.map((node: {
        id: string;
        name: string;
        code: string;
        unitName?: string | null;
          isVaccine?: boolean;
        doses?: number | null;
        stats?: { availableStockOnHand: number };
      }) => ({
        id: node.id,
        itemName: node.name,
        code: node.code,
        units: node.unitName ?? "pack",
        isVaccine: node.isVaccine ?? false,
        dosesPerVial: node.doses ?? null,
        stockOnHand: node.stats?.availableStockOnHand ?? 0,
      }));

    setItems((prev) => {
      const previousById = new Map(prev.map((item) => [item.id, item]));
      return catalogItems.map((item) => {
        const existing = previousById.get(item.id);
        if (existing) {
          return {
            ...existing,
            itemName: item.itemName,
            code: item.code,
            units: item.units,
            isVaccine: item.isVaccine,
            dosesPerVial: item.dosesPerVial,
            stockOnHand: item.stockOnHand,
          };
        }

        return {
          ...item,
          administeredQty: 0,
          hasOpenVialWastage: false,
          wastageQty: 0,
          wastageAutoSuggested: true,
          details: [],
        };
      });
    });
  }, [itemsData]);

  useEffect(() => {
    let mounted = true;
    prefs
      .get<boolean>(PREF_KEYS.DAILY_TALLY_ENABLE_BREAKDOWN)
      .then((enabled) => {
        if (!mounted) return;
        setDetailBreakdownEnabled(enabled ?? false);
      });

    return () => {
      mounted = false;
    };
  }, [prefs]);

  const activeItem = useMemo(
    () => items.find((item) => item.id === activeItemId) ?? null,
    [items, activeItemId]
  );

  const administeredFor = (item: TallyItem) => item.administeredQty;

  const detailBreakdownTotalFor = (item: TallyItem) =>
    item.details.reduce((sum, detail) => sum + detail.issuedQty, 0);

  const rowUnitLabel = (item: TallyItem) => {
    if (item.isVaccine && (item.dosesPerVial ?? 0) > 0) return "doses";
    return item.units;
  };

  const toRowUnits = (item: TallyItem, packsQty: number) => {
    if (item.isVaccine && (item.dosesPerVial ?? 0) > 0) {
      return packsQty * (item.dosesPerVial ?? 1);
    }
    return packsQty;
  };

  const toPackUnits = (item: TallyItem, rowQty: number) => {
    if (item.isVaccine && (item.dosesPerVial ?? 0) > 0) {
      return rowQty / (item.dosesPerVial ?? 1);
    }
    return rowQty;
  };

  const roundQty = (qty: number) => Math.round(qty * 10000) / 10000;

  const stockOnHandFor = (item: TallyItem) => toRowUnits(item, item.stockOnHand);

  const remainingFor = (item: TallyItem) =>
    stockOnHandFor(item) - administeredFor(item) - item.wastageQty;

  const updateItem = (itemId: string, updater: (item: TallyItem) => TallyItem) => {
    setItems((prev) => prev.map((item) => (item.id === itemId ? updater(item) : item)));
  };

  const handleAddBreakdown = () => {
    if (!activeItemId) return;

    const issuedQty = parseInt(draft.issuedQty, 10);
    if (Number.isNaN(issuedQty) || issuedQty <= 0) {
      setError("Issued quantity must be a positive number");
      return;
    }

    setError(null);
    updateItem(activeItemId, (item) => ({
      ...item,
      details: [
        ...item.details,
        {
          id: `${item.id}-${Date.now()}`,
          gender: draft.gender,
          ageGroup: draft.ageGroup,
          issuedQty,
        },
      ],
    }));
    setDraft((prev) => ({ ...prev, issuedQty: "" }));
  };

  const handleDeleteBreakdown = (itemId: string, detailId: string) => {
    updateItem(itemId, (item) => ({
      ...item,
      details: item.details.filter((detail) => detail.id !== detailId),
    }));
  };

  const handleWastageChange = (itemId: string, value: string) => {
    const parsed = parseInt(value, 10);
    const wastageQty = Number.isNaN(parsed) || parsed < 0 ? 0 : parsed;
    updateItem(itemId, (item) => ({ ...item, wastageQty, wastageAutoSuggested: false }));
  };

  const handleOpenVialToggle = (itemId: string, enabled: boolean) => {
    updateItem(itemId, (item) => {
      if (!enabled) {
        return {
          ...item,
          hasOpenVialWastage: false,
          wastageQty: 0,
          wastageAutoSuggested: true,
        };
      }

      const suggested = suggestedOpenWastageFor(item) ?? 0;
      return {
        ...item,
        hasOpenVialWastage: true,
        wastageQty: suggested,
        wastageAutoSuggested: true,
      };
    });
  };

  const handleAdministeredChange = (itemId: string, value: string) => {
    const parsed = parseInt(value, 10);
    const administeredQty = Number.isNaN(parsed) || parsed < 0 ? 0 : parsed;
    updateItem(itemId, (item) => {
      const next = { ...item, administeredQty };

      // Keep auto-suggested wastage in sync with used qty until user edits manually.
      if (next.hasOpenVialWastage && next.wastageAutoSuggested) {
        const suggested = suggestedOpenWastageFor(next) ?? 0;
        next.wastageQty = suggested;
      }

      return next;
    });
  };

  const distributeReduction = async (
    itemLines: Array<{
      id: string;
      snapshotNumberOfPacks: number;
      expiryDate: string | null;
    }>,
    targetCount: number
  ) => {
    const totalSnapshot = itemLines.reduce(
      (sum, line) => sum + line.snapshotNumberOfPacks,
      0
    );

    const sorted = [...itemLines].sort((a, b) => {
      if (!a.expiryDate && !b.expiryDate) return 0;
      if (!a.expiryDate) return 1;
      if (!b.expiryDate) return -1;
      return a.expiryDate.localeCompare(b.expiryDate);
    });

    const lineCounts = new Map<string, number>();

    if (targetCount >= totalSnapshot) {
      for (const line of sorted) {
        lineCounts.set(line.id, line.snapshotNumberOfPacks);
      }
      const excess = targetCount - totalSnapshot;
      if (excess > 0 && sorted.length > 0) {
        const longest = sorted[sorted.length - 1];
        lineCounts.set(longest.id, (lineCounts.get(longest.id) ?? 0) + excess);
      }
    } else {
      let remainingToReduce = totalSnapshot - targetCount;
      for (const line of sorted) {
        const reduce = Math.min(remainingToReduce, line.snapshotNumberOfPacks);
        lineCounts.set(line.id, line.snapshotNumberOfPacks - reduce);
        remainingToReduce -= reduce;
      }
    }

    for (const line of itemLines) {
      await updateStocktakeLine({
        variables: {
          storeId,
          input: {
            id: line.id,
            countedNumberOfPacks: lineCounts.get(line.id) ?? line.snapshotNumberOfPacks,
          },
        },
      });
    }
  };

  const createWastageStocktake = async (
    comment: string,
    wastageByItem: Map<string, number>
  ) => {
    if (!storeId || wastageByItem.size === 0) return;

    const stocktakeId = uuid();
    await insertStocktake({ variables: { storeId, id: stocktakeId } });

    const { data } = await fetchStocktakeLines({
      variables: { storeId, stocktakeId },
      fetchPolicy: "network-only",
    });

    const lines = data?.stocktakeLines?.nodes ?? [];
    for (const [itemId, wastage] of wastageByItem) {
      if (wastage <= 0) continue;

      const itemLines = lines.filter((line: { itemId: string }) => line.itemId === itemId);
      if (itemLines.length === 0) continue;

      const totalSnapshot = itemLines.reduce(
        (sum: number, line: { snapshotNumberOfPacks: number }) =>
          sum + line.snapshotNumberOfPacks,
        0
      );
      const targetCount = Math.max(0, totalSnapshot - wastage);
      await distributeReduction(itemLines, targetCount);
    }

    await finaliseStocktake({
      variables: {
        storeId,
        input: { id: stocktakeId, status: "FINALISED", comment },
      },
    });
  };

  const administeredItems = useMemo(
    () =>
      items
        .map((item) => ({
          itemId: item.id,
          quantity: administeredFor(item),
          quantityInPacks: roundQty(toPackUnits(item, administeredFor(item))),
          itemName: item.itemName,
          units: rowUnitLabel(item),
          isVaccine: item.isVaccine,
        }))
        .filter((item) => item.quantity > 0),
    [items]
  );

  const openWastageByItem = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of items) {
      if (item.hasOpenVialWastage && item.wastageQty > 0) {
        map.set(item.id, roundQty(toPackUnits(item, item.wastageQty)));
      }
    }
    return map;
  }, [items]);

  const validateForConfirm = () => {
    if (!storeId) return false;
    if (items.length === 0) {
      setError("Add at least one item before confirming.");
      return false;
    }

    const hasNegativeBalance = items.some((item) => remainingFor(item) < 0);
    if (hasNegativeBalance) {
      setError("Remaining balance cannot be negative. Adjust quantities first.");
      return false;
    }

    if (
      administeredItems.length === 0 &&
      openWastageByItem.size === 0
    ) {
      setError("Enter administered quantities or wastage before confirming.");
      return false;
    }

    const invalidVaccine = items.find(
      (item) =>
        item.isVaccine &&
        (item.administeredQty > 0 || item.wastageQty > 0) &&
        (!item.dosesPerVial || item.dosesPerVial <= 0)
    );

    if (invalidVaccine) {
      setError(
        `Item ${invalidVaccine.itemName} is vaccine but doses per vial is not configured.`
      );
      return false;
    }

    setError(null);
    return true;
  };

  const buildPrescriptionComment = () => {
    const demographicTotals = new Map<string, number>();

    for (const item of items) {
      for (const detail of item.details) {
        const key = `${detail.gender}/${detail.ageGroup}`;
        demographicTotals.set(key, (demographicTotals.get(key) ?? 0) + detail.issuedQty);
      }
    }

    const demographicSummary = detailBreakdownEnabled
      ? Array.from(demographicTotals.entries())
          .map(([key, qty]) => `${key}:${qty}`)
          .join(",")
      : "";

    const itemSummary = administeredItems
      .map((item) => `${item.itemName}:${item.quantity}`)
      .join(",");

    return [
      "Daily tally administered totals",
      itemSummary ? `Items=${itemSummary}` : "",
      demographicSummary ? `Demographics=${demographicSummary}` : "",
    ]
      .filter(Boolean)
      .join(" | ");
  };

  const handleConfirmDailyTally = async () => {
    if (!validateForConfirm()) return;

    setSaving(true);

    try {
      if (administeredItems.length > 0) {
        const patientId = await prefs.get<string>(PREF_KEYS.NAME_ID);
        if (!patientId) {
          throw new Error("Set a generic patient in Settings before confirming tally.");
        }

        const prescriptionId = uuid();
        await insertPrescription({
          variables: { storeId, id: prescriptionId, patientId },
        });

        for (const item of administeredItems) {
          const { data } = await stockLinesQuery({
            variables: { storeId, itemId: item.itemId },
            fetchPolicy: "network-only",
          });

          const stockNodes = data?.stockLines?.nodes ?? [];
          const lines: { id: string; stockLineId: string; numberOfPacks: number }[] = [];
          let remaining = item.quantityInPacks;

          for (const sl of stockNodes) {
            if (remaining <= 0) break;
            const available = sl.availableNumberOfPacks ?? 0;
            if (available <= 0) continue;
            const take = roundQty(Math.min(remaining, available));
            lines.push({ id: uuid(), stockLineId: sl.id, numberOfPacks: take });
            remaining = roundQty(remaining - take);
          }

          if (remaining > 0) {
            throw new Error(`Insufficient stock to issue ${item.quantity} for ${item.itemName}.`);
          }

          if (lines.length > 0) {
            await savePrescriptionLines({
              variables: {
                storeId,
                input: { invoiceId: prescriptionId, itemId: item.itemId, lines },
              },
            });
          }
        }

        await updatePrescription({
          variables: {
            storeId,
            input: {
              id: prescriptionId,
              status: "PICKED",
              comment: buildPrescriptionComment(),
            },
          },
        });
      }

      if (openWastageByItem.size > 0) {
        await createWastageStocktake("open vial wastage", openWastageByItem);
      }

      navigate("/home", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to confirm.");
      setSaving(false);
    }
  };

  const filteredItems = useMemo(() => {
    const q = itemFilter.trim().toLowerCase();
    if (!q) return items;

    return items.filter(
      (item) =>
        item.itemName.toLowerCase().includes(q) ||
        item.code.toLowerCase().includes(q)
    );
  }, [items, itemFilter]);

  const suggestedOpenWastageFor = (item: TallyItem) => {
    const dosesPerVial = item.dosesPerVial ?? 0;
    const administered = administeredFor(item);

    if (dosesPerVial <= 0 || administered <= 0) return null;

    const stockOnHand = stockOnHandFor(item);
    const openRemainderFromStock = stockOnHand % dosesPerVial;

    // Consume already-open remainder first. New vial wastage is based on what
    // remains to administer after that carry-over quantity.
    if (administered <= openRemainderFromStock) {
      return 0;
    }

    const fromNewVials = administered - openRemainderFromStock;
    const remainder = fromNewVials % dosesPerVial;
    if (remainder === 0) return 0;
    return dosesPerVial - remainder;
  };

  return (
    <div className="screen-container">
      <div className="screen-header">
        <BackButton onClick={() => (activeItemId ? setActiveItemId(null) : navigate("/home"))} />
        <h1 className="screen-header-title">
          {activeItem ? "Daily Tally Detail" : "Daily Tally"}
        </h1>
        <div className="w-10" />
      </div>

      <div className="screen-body space-y-3">
        {!activeItem && (
          <>
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              Use this screen when you do not want to issue by individual patient.
              Administered totals create prescriptions, and wastage creates stocktakes
              based on wastage objective.
            </div>

            <input
              className="input-field"
                placeholder="Filter items (contains text e.g. vaccine)..."
              value={itemFilter}
              onChange={(e) => setItemFilter(e.target.value)}
            />

            {error && (
              <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            )}

              <p className="text-xs text-gray-500">
                Items loaded: {items.length}. Detail breakdown: {detailBreakdownEnabled ? "ON" : "OFF"}.
              </p>

            {itemsLoadError && (
              <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
                Failed to load items list.
              </div>
            )}

            {loadingItems && items.length === 0 && (
              <div className="card py-6 text-center text-sm text-gray-500">
                Loading items...
              </div>
            )}

            {items.length === 0 && (
              <div className="card py-6 text-center text-sm text-gray-500">
                No items available for daily tally.
              </div>
            )}

            {!loadingItems && items.length > 0 && filteredItems.length === 0 && (
              <div className="card py-6 text-center text-sm text-gray-500">
                No items match your filter.
              </div>
            )}

              {filteredItems.length > 0 && (
                <div className="card p-0">
                  <div className="overflow-x-auto">
                    <table className="min-w-[960px] w-full text-sm">
                      <thead className="sticky top-0 z-10 bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                        <tr>
                          <th className="px-3 py-2 text-left">Item</th>
                            <th className="px-3 py-2 text-right">SOH</th>
                            <th className="px-3 py-2 text-right">Used</th>
                            <th className="px-3 py-2 text-left">Units</th>
                            <th className="px-3 py-2 text-center">Open vial wastage?</th>
                            <th className="px-3 py-2 text-right">Wastage</th>
                            <th className="px-3 py-2 text-right">Remaining stock</th>
                            {detailBreakdownEnabled && (
                              <th className="px-3 py-2 text-center">Details</th>
                            )}
                        </tr>
                      </thead>
                      <tbody>
                        {filteredItems.map((item) => {
                          const remaining = remainingFor(item);
                            const stockOnHand = stockOnHandFor(item);
                          return (
                            <tr key={item.id} className="border-t border-gray-100 align-middle">
                              <td className="px-3 py-2 font-medium text-gray-900">{item.itemName}</td>
                                <td className="px-3 py-2 text-right font-medium">{stockOnHand}</td>
                                <td className="px-3 py-2">
                                  <input
                                    type="number"
                                    min={0}
                                    inputMode="numeric"
                                    className="w-24 rounded border border-gray-300 px-2 py-1 text-right"
                                      value={item.administeredQty}
                                      onChange={(e) => handleAdministeredChange(item.id, e.target.value)}
                                  />
                                    {detailBreakdownEnabled && (
                                      <p className="mt-1 text-[10px] text-gray-500 text-right">
                                        Breakdown total: {detailBreakdownTotalFor(item)}
                                      </p>
                                    )}
                              </td>
                                <td className="px-3 py-2 text-gray-700">{rowUnitLabel(item)}</td>
                              <td className="px-3 py-2">
                                  <div className="flex items-center justify-center gap-1">
                                    <button
                                      className={`rounded px-2 py-1 text-xs font-semibold ${
                                        item.hasOpenVialWastage
                                          ? "bg-primary-100 text-primary-700"
                                          : "bg-gray-100 text-gray-600"
                                      }`}
                                      onClick={() => handleOpenVialToggle(item.id, true)}
                                    >
                                      Yes
                                    </button>
                                    <button
                                      className={`rounded px-2 py-1 text-xs font-semibold ${
                                        !item.hasOpenVialWastage
                                          ? "bg-primary-100 text-primary-700"
                                          : "bg-gray-100 text-gray-600"
                                      }`}
                                      onClick={() => handleOpenVialToggle(item.id, false)}
                                    >
                                      No
                                    </button>
                                  </div>
                              </td>
                                <td className="px-3 py-2">
                                  <div className="space-y-1">
                                    {item.hasOpenVialWastage ? (
                                    <input
                                      type="number"
                                      min={0}
                                      inputMode="numeric"
                                      className="w-24 rounded border border-gray-300 px-2 py-1 text-right"
                                        value={item.wastageQty}
                                        onChange={(e) => handleWastageChange(item.id, e.target.value)}
                                    />
                                    ) : (
                                      <p className="text-right text-gray-400">0</p>
                                  )}
                                    {(() => {
                                      const suggested = suggestedOpenWastageFor(item);
                                      const administered = administeredFor(item);
                                      if (
                                        !item.hasOpenVialWastage ||
                                        suggested === null ||
                                        suggested === item.wastageQty ||
                                        administered <= 0
                                      ) {
                                        return null;
                                      }

                                      return (
                                        <div className="rounded border border-amber-200 bg-amber-50 p-1 text-[10px] leading-tight text-amber-800">
                                          Used {administered} with {item.dosesPerVial} doses/vial suggests wastage {suggested} doses.
                                          <button
                                            className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900"
                                            onClick={() =>
                                              updateItem(item.id, (current) => ({
                                                ...current,
                                                hasOpenVialWastage: true,
                                                wastageQty: suggested,
                                              }))
                                            }
                                          >
                                            Use {suggested}
                                          </button>
                                        </div>
                                      );
                                    })()}
                                  </div>
                                </td>
                              <td className={`px-3 py-2 text-right font-semibold ${remaining < 0 ? "text-red-600" : "text-gray-900"}`}>
                                {remaining}
                              </td>
                                {detailBreakdownEnabled && (
                                  <td className="px-3 py-2 text-center">
                                    <button
                                      className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 active:bg-gray-100"
                                      onClick={() => setActiveItemId(item.id)}
                                    >
                                      Open
                                    </button>
                                  </td>
                                )}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="border-t border-gray-100 px-3 py-2 text-xs text-gray-500">
                      Used {"->"} Prescription. Wastage {"->"} Stocktake with open vial wastage comment.
                  </div>
                </div>
              )}

            <button
              className="btn-primary"
              onClick={handleConfirmDailyTally}
              disabled={saving}
            >
              {saving ? "Saving..." : "Confirm"}
            </button>
          </>
        )}

        {activeItem && detailBreakdownEnabled && (
          <div className="space-y-3">
            <div className="card space-y-1">
              <p className="font-semibold">{activeItem.itemName}</p>
              <p className="text-sm text-gray-500">
                Add breakdown rows by gender, age group and issued quantity.
              </p>
            </div>

            <div className="card space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <label>
                  <p className="mb-1 text-xs text-gray-500">Gender</p>
                  <select
                    className="w-full rounded border border-gray-300 bg-white px-2 py-2 text-sm"
                    value={draft.gender}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        gender: e.target.value as Gender,
                      }))
                    }
                  >
                    {genderOptions.map((gender) => (
                      <option key={gender} value={gender}>
                        {gender}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <p className="mb-1 text-xs text-gray-500">Age group</p>
                  <select
                    className="w-full rounded border border-gray-300 bg-white px-2 py-2 text-sm"
                    value={draft.ageGroup}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        ageGroup: e.target.value as AgeGroup,
                      }))
                    }
                  >
                    {ageGroupOptions.map((ageGroup) => (
                      <option key={ageGroup} value={ageGroup}>
                        {ageGroup}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label>
                <p className="mb-1 text-xs text-gray-500">Issued quantity</p>
                <input
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
                  type="number"
                  min={1}
                  inputMode="numeric"
                  value={draft.issuedQty}
                  onChange={(e) =>
                    setDraft((prev) => ({ ...prev, issuedQty: e.target.value }))
                  }
                />
              </label>

              {error && <p className="text-sm text-red-600">{error}</p>}

              <button className="btn-primary" onClick={handleAddBreakdown}>
                Add Breakdown Row
              </button>
            </div>

            <div className="card space-y-2">
              <p className="text-sm font-semibold">Breakdown rows</p>
              {activeItem.details.length === 0 ? (
                <p className="text-sm text-gray-500">No rows added yet.</p>
              ) : (
                <div className="space-y-2">
                  {activeItem.details.map((detail) => (
                    <div
                      key={detail.id}
                      className="flex items-center justify-between rounded-lg border border-gray-200 p-2 text-sm"
                    >
                      <div>
                        <p className="font-medium">
                          {detail.gender} • {detail.ageGroup}
                        </p>
                        <p className="text-xs text-gray-500">Issued: {detail.issuedQty}</p>
                      </div>
                      <button
                        className="rounded p-1 text-red-500 active:bg-red-50"
                        onClick={() => handleDeleteBreakdown(activeItem.id, detail.id)}
                        aria-label="Delete row"
                      >
                        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M6 18L18 6M6 6l12 12"
                          />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <button className="btn-secondary" onClick={() => setActiveItemId(null)}>
              Back to Daily Tally
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
