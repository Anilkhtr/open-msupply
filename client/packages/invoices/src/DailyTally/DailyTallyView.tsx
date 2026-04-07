import React, { useEffect, useMemo, useState } from 'react';
import {
  AppBarButtonsPortal,
  AppBarContentPortal,
  BasicTextInput,
  Box,
  ColumnDef,
  DialogButton,
  FnUtils,
  LoadingButton,
  MaterialTable,
  RouteBuilder,
  SaveIcon,
  Stack,
  Switch,
  Typography,
  UpdatePrescriptionStatusInput,
  UpdateStocktakeStatusInput,
  useDialog,
  useNavigate,
  useNonPaginatedMaterialTable,
  useNotification,
  useQuery,
  useTranslation,
  ItemNodeType,
} from '@openmsupply-client/common';
import { AppRoute } from '@openmsupply-client/config';
import {
  PatientSearchInput,
  SearchInputPatient,
  useItemApi,
} from '@openmsupply-client/system';
import { usePrescription } from '../Prescriptions/api';
import { usePrescriptionGraphQL } from '../Prescriptions/api/usePrescriptionGraphQL';
import { useStocktakeGraphQL } from '@openmsupply-client/inventory/src/Stocktake/api/useStocktakeGraphQL';

type TallyStockLine = {
  id: string;
  expiryDate?: string | null;
  availableNumberOfPacks: number;
  packSize: number;
};

type ItemGroup = {
  itemId: string;
  name: string;
  unitName: string;
  isVaccine: boolean;
  doses: number;
  sohPacks: number;
  stockLines: TallyStockLine[];
};

type DailyTallyRow = {
  itemId: string;
  item: string;
  soh: number;
  used: number;
  units: string;
  openVialWastage: boolean;
  wastage: number;
  remainingStock: number;
  isVaccine: boolean;
  doses: number;
  stockLines: TallyStockLine[];
  batchDraftById?: Record<string, BatchDraft>;
};

type BatchDraft = {
  used: number;
  openVialWastage: boolean;
  wastage: number;
};

type RowDraft = {
  used: number;
  openVialWastage: boolean;
  wastage: number;
  batchDraftById?: Record<string, BatchDraft>;
};

type ConfirmationSummaryRow = {
  item: string;
  batch: string;
  issued: string;
  wastage: string;
};

const round = (value: number) => Math.round((value + Number.EPSILON) * 1000) / 1000;

const defaultDailyTallyReference = () => {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = String(now.getFullYear());

  return `daily tally-${day}/${month}/${year}`;
};

const toDisplayUnits = (packs: number, isVaccine: boolean, doses: number) => {
  if (isVaccine && doses > 0) return round(packs * doses);
  return round(packs);
};

const toPacks = (displayUnits: number, isVaccine: boolean, doses: number) => {
  if (isVaccine && doses > 0) return round(displayUnits / doses);
  return round(displayUnits);
};

const parseInput = (value: string) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
};

const allocateAcrossStockLines = (
  stockLines: TallyStockLine[],
  requiredPacks: number
) => {
  let remaining = requiredPacks;
  const byExpiry = [...stockLines].sort((a, b) => {
    if (!a.expiryDate && !b.expiryDate) return 0;
    if (!a.expiryDate) return 1;
    if (!b.expiryDate) return -1;
    return a.expiryDate.localeCompare(b.expiryDate);
  });

  const allocations: Array<{ stockLine: TallyStockLine; packs: number }> = [];
  for (const stockLine of byExpiry) {
    if (remaining <= 0) break;
    const available = Math.max(0, stockLine.availableNumberOfPacks);
    if (available <= 0) continue;

    const allocated = Math.min(available, remaining);
    if (allocated > 0) {
      allocations.push({ stockLine, packs: round(allocated) });
      remaining = round(remaining - allocated);
    }
  }

  return { allocations, remaining };
};

const getSuggestedOpenVialWastage = ({
  soh,
  used,
  isVaccine,
  doses,
}: Pick<DailyTallyRow, 'soh' | 'used' | 'isVaccine' | 'doses'>) => {
  if (!isVaccine || doses <= 0 || used <= 0) return null;

  const stockOnHand = round(soh);
  const administered = round(used);
  const openRemainderFromStock = round(stockOnHand % doses);

  if (administered <= openRemainderFromStock) {
    return 0;
  }

  const fromNewVials = round(administered - openRemainderFromStock);
  const remainder = round(fromNewVials % doses);
  if (remainder === 0) return 0;

  return round(doses - remainder);
};

const getOpenVialWastageMessage = (row: DailyTallyRow) => {
  if (!row.openVialWastage) return null;
  if (!row.isVaccine || row.doses <= 0) {
    return 'Open vial estimation requires a vaccine item with doses per vial.';
  }
  if (row.used <= 0) {
    return 'Enter used doses to estimate open vial wastage.';
  }

  const suggested = getSuggestedOpenVialWastage(row);
  if (suggested === null) return null;

  return `Used ${row.used} with ${row.doses} doses/vial suggests wastage ${suggested} doses.`;
};

const sumBatchDraft = (
  batchDraftById: Record<string, BatchDraft> | undefined,
  key: 'used' | 'wastage'
) =>
  round(
    Object.values(batchDraftById ?? {}).reduce(
      (acc, draft) => acc + (draft?.[key] ?? 0),
      0
    )
  );

const batchLabel = (stockLine: TallyStockLine) =>
  stockLine.expiryDate || stockLine.id.slice(0, 8);

const sortStockLinesByExpiry = (stockLines: TallyStockLine[]) => {
  return [...stockLines].sort((a, b) => {
    if (!a.expiryDate && !b.expiryDate) return 0;
    if (!a.expiryDate) return 1;
    if (!b.expiryDate) return -1;
    return a.expiryDate.localeCompare(b.expiryDate);
  });
};

export const DailyTallyView = () => {
  const t = useTranslation();
  const navigate = useNavigate();
  const { error, success } = useNotification();
  const {
    create: { create: createPrescription },
  } = usePrescription();
  const { prescriptionApi, storeId } = usePrescriptionGraphQL();
  const { stocktakeApi } = useStocktakeGraphQL();
  const itemApi = useItemApi();

  const [patient, setPatient] = useState<SearchInputPatient | null>(null);
  const [filterText, setFilterText] = useState('');
  const [referenceText, setReferenceText] = useState(defaultDailyTallyReference);
  const [draftByItem, setDraftByItem] = useState<Record<string, RowDraft>>({});
  const [expandedByItem, setExpandedByItem] = useState<Record<string, boolean>>({});
  const [confirmSummaryOpen, setConfirmSummaryOpen] = useState(false);
  const [confirmSummaryRows, setConfirmSummaryRows] = useState<
    ConfirmationSummaryRow[]
  >([]);
  const [isSaving, setIsSaving] = useState(false);

  const { Modal: ConfirmSummaryModal } = useDialog({
    isOpen: confirmSummaryOpen,
    onClose: () => setConfirmSummaryOpen(false),
    disableBackdrop: true,
  });

  const itemQueryParams = useMemo(
    () => ({
      sortBy: { key: 'name', direction: 'asc' as const, isDesc: false },
      offset: 0,
      first: 5000,
      filterBy: {
        type: { equalTo: ItemNodeType.Stock },
        ...(filterText ? { search: { like: filterText } } : {}),
      },
    }),
    [filterText]
  );

  const { data, isLoading, isError } = useQuery({
    queryKey: itemApi.keys.paramList(itemQueryParams),
    queryFn: () => itemApi.get.stockItemsWithStockLines(itemQueryParams),
    keepPreviousData: true,
  });

  const groupedItems = useMemo((): ItemGroup[] => {
    return (data?.nodes ?? [])
      .map(item => ({
        itemId: item.id,
        name: item.name,
        unitName: item.unitName || 'Units',
        isVaccine: item.isVaccine,
        doses: item.doses,
        sohPacks: round(item.availableStockOnHand),
        stockLines: item.availableBatches.nodes.map(stockLine => ({
          id: stockLine.id,
          expiryDate: stockLine.expiryDate,
          availableNumberOfPacks: round(stockLine.availableNumberOfPacks),
          packSize: stockLine.packSize,
        })),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [data?.nodes]);

  useEffect(() => {
    setDraftByItem(previous => {
      const next = { ...previous };
      for (const item of groupedItems) {
        if (!next[item.itemId]) {
          next[item.itemId] = {
            used: 0,
            wastage: 0,
            openVialWastage: false,
            batchDraftById:
              item.stockLines.length > 1
                ? item.stockLines.reduce<Record<string, BatchDraft>>((acc, line) => {
                    acc[line.id] = {
                      used: 0,
                      wastage: 0,
                      openVialWastage: item.isVaccine,
                    };
                    return acc;
                  }, {})
                : undefined,
          };
        } else if (item.stockLines.length > 1) {
          const currentDraft = next[item.itemId] ?? {
            used: 0,
            wastage: 0,
            openVialWastage: false,
          };
          const existing = currentDraft.batchDraftById ?? {};
          const merged = { ...existing };
          for (const line of item.stockLines) {
            if (!merged[line.id]) {
              merged[line.id] = {
                used: 0,
                wastage: 0,
                openVialWastage: item.isVaccine,
              };
            } else if (!item.isVaccine) {
              const existingBatch = merged[line.id];
              merged[line.id] = {
                used: existingBatch?.used ?? 0,
                openVialWastage: false,
                wastage: 0,
              };
            }
          }
          next[item.itemId] = {
            used: currentDraft.used,
            wastage: currentDraft.wastage,
            openVialWastage: item.isVaccine ? currentDraft.openVialWastage : false,
            batchDraftById: merged,
          };
        }
      }
      return next;
    });
  }, [groupedItems]);

  const rows = useMemo((): DailyTallyRow[] => {
    return groupedItems.map(item => {
      const draft = draftByItem[item.itemId] || {
        used: 0,
        wastage: 0,
        openVialWastage: false,
      };
      const isMultiBatch = item.stockLines.length > 1;
      const sohDisplay = toDisplayUnits(item.sohPacks, item.isVaccine, item.doses);
      const effectiveWastage = isMultiBatch
        ? sumBatchDraft(draft.batchDraftById, 'wastage')
        : draft.wastage;
      const remaining = round(sohDisplay - draft.used - effectiveWastage);

      return {
        itemId: item.itemId,
        item: item.name,
        soh: sohDisplay,
        used: draft.used,
        units: item.isVaccine ? t('label.doses') : item.unitName,
        openVialWastage: draft.openVialWastage,
        wastage: effectiveWastage,
        remainingStock: remaining,
        isVaccine: item.isVaccine,
        doses: item.doses,
        stockLines: item.stockLines,
        batchDraftById: draft.batchDraftById,
      };
    });
  }, [draftByItem, groupedItems, t]);

  const updateDraft = (itemId: string, patch: Partial<RowDraft>) => {
    setDraftByItem(previous => ({
      ...previous,
      [itemId]: {
        used: previous[itemId]?.used ?? 0,
        wastage: previous[itemId]?.wastage ?? 0,
        openVialWastage: previous[itemId]?.openVialWastage ?? false,
        batchDraftById: previous[itemId]?.batchDraftById,
        ...patch,
      },
    }));
  };

  const updateUsed = (row: DailyTallyRow, rawValue: string) => {
    const used = parseInput(rawValue);

    if (row.stockLines.length > 1) {
      setDraftByItem(previous => {
        const rowDraft = previous[row.itemId] ?? {
          used: 0,
          wastage: 0,
          openVialWastage: false,
        };
        const existingBatchDraft = rowDraft.batchDraftById ?? {};
        const sortedStockLines = sortStockLinesByExpiry(row.stockLines);

        let remaining = used;
        const nextBatchDraftById = sortedStockLines.reduce<Record<string, BatchDraft>>(
          (acc, stockLine) => {
            const availableDisplay = toDisplayUnits(
              stockLine.availableNumberOfPacks,
              row.isVaccine,
              row.doses
            );
            const allocatedUsed = round(Math.min(Math.max(remaining, 0), availableDisplay));
            remaining = round(Math.max(0, remaining - allocatedUsed));

            const openVialWastage =
              existingBatchDraft[stockLine.id]?.openVialWastage ?? row.isVaccine;
            const wastage = batchCalculatedWastage(
              row,
              stockLine,
              allocatedUsed,
              openVialWastage
            );

            acc[stockLine.id] = {
              used: allocatedUsed,
              openVialWastage,
              wastage,
            };

            return acc;
          },
          {}
        );

        return {
          ...previous,
          [row.itemId]: {
            ...rowDraft,
            used,
            wastage: sumBatchDraft(nextBatchDraftById, 'wastage'),
            batchDraftById: nextBatchDraftById,
          },
        };
      });

      if (used > 0) {
        setExpandedByItem(previous => ({ ...previous, [row.itemId]: true }));
      }
      return;
    }

    const nextRow = { ...row, used };
    const suggested = row.openVialWastage
      ? getSuggestedOpenVialWastage(nextRow)
      : null;

    updateDraft(row.itemId, {
      used,
      ...(suggested !== null ? { wastage: suggested } : {}),
    });

    if (row.stockLines.length > 1 && used > 0) {
      setExpandedByItem(previous => ({ ...previous, [row.itemId]: true }));
    }
  };

  const updateOpenVialWastage = (row: DailyTallyRow, checked: boolean) => {
    const nextChecked = row.isVaccine ? checked : false;
    const suggested = nextChecked ? getSuggestedOpenVialWastage(row) : null;

    updateDraft(row.itemId, {
      openVialWastage: nextChecked,
      ...(nextChecked && suggested !== null ? { wastage: suggested } : {}),
    });
  };

  const batchSuggestion = (row: DailyTallyRow, used: number) => {
    if (!row.isVaccine || row.doses <= 0 || used <= 0) return 0;

    const remainder = round(used % row.doses);
    if (remainder === 0) return 0;

    return round(row.doses - remainder);
  };

  const batchCalculatedWastage = (
    row: DailyTallyRow,
    _stockLine: TallyStockLine,
    used: number,
    isOpenVialWastage: boolean
  ) => {
    if (!isOpenVialWastage) return 0;
    if (used <= 0) return 0;
    return batchSuggestion(row, used);
  };

  const updateBatchUsed = (
    row: DailyTallyRow,
    stockLine: TallyStockLine,
    rawValue: string
  ) => {
    const used = parseInput(rawValue);
    setDraftByItem(previous => {
      const rowDraft = previous[row.itemId] ?? {
        used: 0,
        wastage: 0,
        openVialWastage: false,
      };
      const batchDraftById = rowDraft.batchDraftById ?? {};
      const currentBatchDraft = batchDraftById[stockLine.id] ?? {
        used: 0,
        wastage: 0,
        openVialWastage: row.isVaccine,
      };

      const suggested = currentBatchDraft.openVialWastage
        ? batchSuggestion(row, used)
        : 0;

      const nextBatchDraftById = {
        ...batchDraftById,
        [stockLine.id]: {
          ...currentBatchDraft,
          used,
          wastage: suggested ?? 0,
        },
      };

      return {
        ...previous,
        [row.itemId]: {
          ...rowDraft,
          used: sumBatchDraft(nextBatchDraftById, 'used'),
          wastage: sumBatchDraft(nextBatchDraftById, 'wastage'),
          batchDraftById: nextBatchDraftById,
        },
      };
    });
  };

  const updateBatchOpenVialWastage = (
    row: DailyTallyRow,
    stockLine: TallyStockLine,
    checked: boolean
  ) => {
    setDraftByItem(previous => {
      const rowDraft = previous[row.itemId] ?? {
        used: 0,
        wastage: 0,
        openVialWastage: false,
      };
      const batchDraftById = rowDraft.batchDraftById ?? {};
      const currentBatchDraft = batchDraftById[stockLine.id] ?? {
        used: 0,
        wastage: 0,
        openVialWastage: row.isVaccine,
      };

      const nextChecked = row.isVaccine ? checked : false;
      const nextWastage = nextChecked
        ? batchSuggestion(row, currentBatchDraft.used)
        : 0;

      const nextBatchDraftById = {
        ...batchDraftById,
        [stockLine.id]: {
          ...currentBatchDraft,
          openVialWastage: nextChecked,
          wastage: nextWastage,
        },
      };

      return {
        ...previous,
        [row.itemId]: {
          ...rowDraft,
          used: sumBatchDraft(nextBatchDraftById, 'used'),
          wastage: sumBatchDraft(nextBatchDraftById, 'wastage'),
          batchDraftById: nextBatchDraftById,
        },
      };
    });
  };

  const issuedBatchSummary = (row: DailyTallyRow) =>
    row.stockLines
      .filter(stockLine => (row.batchDraftById?.[stockLine.id]?.used ?? 0) > 0)
      .map(stockLine => {
        const used = row.batchDraftById?.[stockLine.id]?.used ?? 0;
        return `${batchLabel(stockLine)} (${used})`;
      })
      .join(', ');

  const buildConfirmationRows = (activeRows: DailyTallyRow[]) => {
    const summaryRows: ConfirmationSummaryRow[] = [];

    for (const row of activeRows) {
      const unitLabel = row.units.toLowerCase();

      if (row.stockLines.length > 1) {
        const batchDraftById = draftByItem[row.itemId]?.batchDraftById ?? {};
        for (const stockLine of row.stockLines) {
          const batchUsed = batchDraftById[stockLine.id]?.used ?? 0;
          const isOpen = batchDraftById[stockLine.id]?.openVialWastage ?? row.isVaccine;
          const batchWastage = batchCalculatedWastage(row, stockLine, batchUsed, isOpen);
          if (batchUsed <= 0 && batchWastage <= 0) continue;

          summaryRows.push({
            item: row.item,
            batch: batchLabel(stockLine),
            issued: `${batchUsed} ${unitLabel}`,
            wastage: `${batchWastage} ${unitLabel}`,
          });
        }
        continue;
      }

      const usedPacks = toPacks(row.used, row.isVaccine, row.doses);
      const wastagePacks = toPacks(row.wastage, row.isVaccine, row.doses);
      const usedAllocations =
        row.used > 0
          ? allocateAcrossStockLines(row.stockLines, usedPacks).allocations
          : [];
      const wastageAllocations =
        row.wastage > 0
          ? allocateAcrossStockLines(row.stockLines, wastagePacks).allocations
          : [];

      const lineIds = new Set<string>([
        ...usedAllocations.map(a => a.stockLine.id),
        ...wastageAllocations.map(a => a.stockLine.id),
      ]);

      for (const stockLineId of lineIds) {
        const stockLine = row.stockLines.find(line => line.id === stockLineId);
        if (!stockLine) continue;

        const issuedPacks =
          usedAllocations.find(a => a.stockLine.id === stockLineId)?.packs ?? 0;
        const wastedPacks =
          wastageAllocations.find(a => a.stockLine.id === stockLineId)?.packs ?? 0;

        const issued = toDisplayUnits(issuedPacks, row.isVaccine, row.doses);
        const wasted = toDisplayUnits(wastedPacks, row.isVaccine, row.doses);

        if (issued <= 0 && wasted <= 0) continue;

        summaryRows.push({
          item: row.item,
          batch: batchLabel(stockLine),
          issued: `${issued} ${unitLabel}`,
          wastage: `${wasted} ${unitLabel}`,
        });
      }
    }

    return summaryRows;
  };

  const columns = useMemo(
    (): ColumnDef<DailyTallyRow>[] => [
      {
        accessorKey: 'item',
        header: t('label.item'),
        size: 360,
      },
      {
        accessorKey: 'soh',
        header: t('label.soh'),
        size: 90,
      },
      {
        accessorKey: 'used',
        header: 'Used',
        size: 130,
        Cell: ({ row }) => (
          <BasicTextInput
            type="number"
            size="small"
            value={String(row.original.used)}
            onChange={event => updateUsed(row.original, event.target.value)}
            sx={{ width: 90 }}
          />
        ),
      },
      {
        accessorKey: 'units',
        header: t('label.unit-name'),
        size: 120,
      },
      {
        accessorKey: 'openVialWastage',
        header: 'Open vial wastage',
        size: 170,
        Cell: ({ row }) =>
          row.original.stockLines.length > 1 ? (
            <Typography variant="body2" color="text.secondary">
              Per-batch
            </Typography>
          ) : (
            <Switch
              checked={row.original.isVaccine ? row.original.openVialWastage : false}
              disabled={!row.original.isVaccine}
              onChange={(_, checked) => updateOpenVialWastage(row.original, checked)}
            />
          ),
      },
      {
        accessorKey: 'wastage',
        header: 'Wastage',
        size: 120,
        Cell: ({ row }) => {
          if (row.original.stockLines.length > 1) {
            return <Typography>{row.original.wastage}</Typography>;
          }

          return (
            <Box display="flex" flexDirection="column" gap={0.5}>
              <BasicTextInput
                type="number"
                size="small"
                value={String(row.original.wastage)}
                onChange={event =>
                  updateDraft(row.original.itemId, {
                    wastage: parseInput(event.target.value),
                  })
                }
                sx={{ width: 90 }}
              />
              {getOpenVialWastageMessage(row.original) ? (
                <Typography variant="caption" color="text.secondary" sx={{ maxWidth: 220 }}>
                  {getOpenVialWastageMessage(row.original)}
                </Typography>
              ) : null}
            </Box>
          );
        },
      },
      {
        accessorKey: 'batches',
        header: 'Batches',
        size: 320,
        Cell: ({ row }) => {
          if (row.original.stockLines.length <= 1) {
            return (
              <Typography variant="caption" color="text.secondary">
                Single batch
              </Typography>
            );
          }

          const isExpanded = row.getIsExpanded();
          const canExpand = row.original.used > 0;
          const issuedSummary = issuedBatchSummary(row.original);

          return (
            <Box display="flex" flexDirection="column" gap={0.5}>
              <Typography
                variant="body2"
                color={canExpand ? 'primary' : 'text.secondary'}
                sx={{ cursor: canExpand ? 'pointer' : 'default', width: 'fit-content' }}
                onClick={canExpand ? () => row.toggleExpanded() : undefined}
              >
                {canExpand
                  ? (isExpanded ? '▾' : '▸') + ' ' + (isExpanded ? 'Collapse' : 'Expand')
                  : 'Enter Used to expand'}
              </Typography>

              <Typography variant="caption" color="text.secondary">
                Used {row.original.used}, Wastage {row.original.wastage}
              </Typography>

              <Typography variant="caption" color="text.secondary">
                {issuedSummary || 'No batches entered yet'}
              </Typography>
            </Box>
          );
        },
      },
      {
        accessorKey: 'remainingStock',
        header: 'Remaining stock',
        size: 140,
      },
    ],
    [t]
  );

  const { table } = useNonPaginatedMaterialTable({
    tableId: 'dispensary-daily-tally',
    columns,
    data: rows,
    isLoading,
    isError,
    enableRowSelection: false,
    muiTableBodyRowProps: {
      sx: {
        fontStyle: 'normal',
      },
    },
    getRowId: row => row.itemId,
    enableExpanding: true,
    getRowCanExpand: row =>
      row.original.stockLines.length > 1 && row.original.used > 0,
    state: {
      expanded: expandedByItem,
    },
    onExpandedChange: updater => {
      setExpandedByItem(previous =>
        typeof updater === 'function'
          ? (updater(previous) as Record<string, boolean>)
          : (updater as Record<string, boolean>)
      );
    },
    renderDetailPanel: ({ row }) => {
      const original = row.original;
      if (original.stockLines.length <= 1 || original.used <= 0) return null;

      return (
        <Box sx={{ padding: 1.5, backgroundColor: 'rgba(0,0,0,0.02)' }}>
          <Typography variant="caption" color="text.secondary">
            Enter batch-level Used. Toggle open vial wastage per batch.
          </Typography>
          <Box
            display="grid"
            gridTemplateColumns="minmax(180px,1fr) 110px 170px 120px"
            columnGap={1}
            rowGap={0.75}
            alignItems="center"
            marginTop={0.75}
          >
            <Typography variant="caption" sx={{ fontWeight: 600 }}>
              Batch
            </Typography>
            <Typography variant="caption" sx={{ fontWeight: 600 }}>
              Used
            </Typography>
            <Typography variant="caption" sx={{ fontWeight: 600 }}>
              Open vial wastage
            </Typography>
            <Typography variant="caption" sx={{ fontWeight: 600 }}>
              Wastage
            </Typography>
            {original.stockLines.map(stockLine => {
              const batchDraft = original.batchDraftById?.[stockLine.id] ?? {
                used: 0,
                wastage: 0,
                openVialWastage: original.isVaccine,
              };
              const calculatedWastage = batchCalculatedWastage(
                original,
                stockLine,
                batchDraft.used,
                batchDraft.openVialWastage
              );

              return (
                <React.Fragment key={stockLine.id}>
                  <Typography variant="caption" color="text.secondary">
                    {batchLabel(stockLine)}
                  </Typography>
                  <BasicTextInput
                    type="number"
                    size="small"
                    value={String(batchDraft.used)}
                    onChange={event =>
                      updateBatchUsed(original, stockLine, event.target.value)
                    }
                    sx={{ width: 92 }}
                  />
                  <Box display="flex" justifyContent="center">
                    <Switch
                      checked={original.isVaccine ? batchDraft.openVialWastage : false}
                      disabled={!original.isVaccine || batchDraft.used <= 0}
                      onChange={(_, checked) =>
                        updateBatchOpenVialWastage(original, stockLine, checked)
                      }
                    />
                  </Box>
                  <Typography variant="body2" color="text.secondary" sx={{ minWidth: 32 }}>
                    {calculatedWastage}
                  </Typography>
                </React.Fragment>
              );
            })}
          </Box>
          <Typography variant="caption" color="text.secondary" sx={{ marginTop: 0.75 }}>
            Batch Used total: {sumBatchDraft(original.batchDraftById, 'used')} / Row Used:{' '}
            {original.used}
          </Typography>
          {Math.abs(sumBatchDraft(original.batchDraftById, 'used') - original.used) >
          0.0001 ? (
            <Typography variant="caption" color="error.main" sx={{ display: 'block' }}>
              Batch Used total must exactly match row Used.
            </Typography>
          ) : null}
        </Box>
      );
    },
  });

  const onConfirm = async (skipSummaryDialog = false) => {
    try {
      const tallyReference = referenceText.trim() || defaultDailyTallyReference();
      const activeRows = rows.filter(row => row.used > 0 || row.wastage > 0);
      if (!activeRows.length) {
        error('Enter used or wastage values before confirming')();
        return;
      }

      const invalid = activeRows.find(
        row => row.used + row.wastage > row.soh || row.remainingStock < 0
      );
      if (invalid) {
        error(`Invalid input for ${invalid.item}: Used + Wastage must be <= SOH`)();
        return;
      }

      const usedRows = activeRows.filter(row => row.used > 0);
      const wastageRows = activeRows.filter(row => row.wastage > 0);

      const invalidMultiBatchUsed = usedRows.find(row => {
        if (row.stockLines.length <= 1) return false;
        const batchDraftById = draftByItem[row.itemId]?.batchDraftById;
        const batchUsedTotal = sumBatchDraft(batchDraftById, 'used');
        const hasAnyBatchUsed = Object.values(batchDraftById ?? {}).some(
          batch => (batch?.used ?? 0) > 0
        );

        return !hasAnyBatchUsed || Math.abs(batchUsedTotal - row.used) > 0.0001;
      });

      const invalidMultiBatchCapacity = usedRows.find(row => {
        if (row.stockLines.length <= 1) return false;
        const batchDraftById = draftByItem[row.itemId]?.batchDraftById ?? {};

        return row.stockLines.some(stockLine => {
          const batchUsed = batchDraftById[stockLine.id]?.used ?? 0;
          const availableDisplay = toDisplayUnits(
            stockLine.availableNumberOfPacks,
            row.isVaccine,
            row.doses
          );
          return batchUsed - availableDisplay > 0.0001;
        });
      });

      if (invalidMultiBatchUsed) {
        error(
          `For ${invalidMultiBatchUsed.item}, batch Used is mandatory and must equal row Used.`
        )();
        return;
      }

      if (invalidMultiBatchCapacity) {
        error(
          `For ${invalidMultiBatchCapacity.item}, one or more batch Used values exceed that batch stock.`
        )();
        return;
      }

      if (usedRows.length > 0 && !patient) {
        error('Select a patient before confirming used quantities')();
        return;
      }

      if (!skipSummaryDialog) {
        setConfirmSummaryRows(buildConfirmationRows(activeRows));
        setConfirmSummaryOpen(true);
        return;
      }

      setIsSaving(true);

      if (usedRows.length > 0 && patient) {
        const prescriptionId = FnUtils.generateUUID();
        const prescription = await createPrescription({
          id: prescriptionId,
          patientId: patient.id,
          theirReference: tallyReference,
        });

        const createdPrescriptionId = prescription?.id;
        if (!createdPrescriptionId) {
          throw new Error('Could not create daily tally prescription');
        }

        const lines = usedRows.flatMap(row => {
          if (row.stockLines.length > 1) {
            const batchDraftById = draftByItem[row.itemId]?.batchDraftById ?? {};

            return row.stockLines.flatMap(stockLine => {
              const batchUsed = batchDraftById[stockLine.id]?.used ?? 0;
              if (batchUsed <= 0) return [];

              const packs = toPacks(batchUsed, row.isVaccine, row.doses);
              if (packs - stockLine.availableNumberOfPacks > 0.0001) {
                throw new Error(`Insufficient stock for ${row.item}`);
              }

              return {
                id: FnUtils.generateUUID(),
                invoiceId: createdPrescriptionId,
                stockLineId: stockLine.id,
                numberOfPacks: packs,
                note: `Daily tally used (${row.item})`,
              };
            });
          }

          const requiredPacks = toPacks(row.used, row.isVaccine, row.doses);
          const { allocations, remaining } = allocateAcrossStockLines(
            row.stockLines,
            requiredPacks
          );

          if (remaining > 0.0001) {
            throw new Error(`Insufficient stock for ${row.item}`);
          }

          return allocations.map(({ stockLine, packs }) => ({
            id: FnUtils.generateUUID(),
            invoiceId: createdPrescriptionId,
            stockLineId: stockLine.id,
            numberOfPacks: packs,
            note: `Daily tally used (${row.item})`,
          }));
        });

        if (lines.length === 0) {
          throw new Error('Could not create daily tally prescription lines');
        }

        await prescriptionApi.upsertPrescription({
          storeId,
          input: {
            insertPrescriptionLines: lines,
            updatePrescriptions: [
              {
                id: createdPrescriptionId,
                status: UpdatePrescriptionStatusInput.Picked,
              },
            ],
          },
        });
      }

      if (wastageRows.length > 0) {
        const stocktakeId = FnUtils.generateUUID();
        const inserted = await stocktakeApi.insertStocktake({
          storeId,
          input: {
            id: stocktakeId,
            createBlankStocktake: true,
            description: 'Daily tally wastage',
            comment: tallyReference,
          },
        });

        if (inserted.insertStocktake.__typename !== 'StocktakeNode') {
          throw new Error('Could not create daily tally stocktake');
        }

        const insertStocktakeLines = wastageRows.flatMap(row => {
          if (row.stockLines.length > 1) {
            const batchDraftById = draftByItem[row.itemId]?.batchDraftById ?? {};

            return row.stockLines.flatMap(stockLine => {
              const batchUsed = batchDraftById[stockLine.id]?.used ?? 0;
              const isOpen = batchDraftById[stockLine.id]?.openVialWastage ?? true;
              const batchWastage = batchCalculatedWastage(
                row,
                stockLine,
                batchUsed,
                isOpen
              );
              if (batchWastage <= 0) return [];

              const packs = toPacks(batchWastage, row.isVaccine, row.doses);
              if (packs - stockLine.availableNumberOfPacks > 0.0001) {
                throw new Error(`Insufficient stock for ${row.item}`);
              }

              return {
                id: FnUtils.generateUUID(),
                stocktakeId,
                stockLineId: stockLine.id,
                countedNumberOfPacks: round(stockLine.availableNumberOfPacks - packs),
                packSize: stockLine.packSize,
                comment: isOpen ? 'Open vial wastage' : 'Wastage',
              };
            });
          }

          const requiredPacks = toPacks(row.wastage, row.isVaccine, row.doses);
          const { allocations, remaining } = allocateAcrossStockLines(
            row.stockLines,
            requiredPacks
          );

          if (remaining > 0.0001) {
            throw new Error(`Insufficient stock for ${row.item}`);
          }

          return allocations.map(({ stockLine, packs }) => ({
            id: FnUtils.generateUUID(),
            stocktakeId,
            stockLineId: stockLine.id,
            countedNumberOfPacks: round(stockLine.availableNumberOfPacks - packs),
            packSize: stockLine.packSize,
            comment: row.openVialWastage ? 'Open vial wastage' : 'Wastage',
          }));
        });

        if (insertStocktakeLines.length > 0) {
          await stocktakeApi.upsertStocktakeLines({
            storeId,
            insertStocktakeLines,
          });
        }

        await stocktakeApi.updateStocktake({
          storeId,
          input: {
            id: stocktakeId,
            status: UpdateStocktakeStatusInput.Finalised,
          },
        });
      }

      success('Daily tally confirmed')();
      navigate(RouteBuilder.create(AppRoute.Dispensary).addPart(AppRoute.DailyTally).build());
    } catch (e) {
      error((e as Error).message || 'Unexpected error')();
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      <ConfirmSummaryModal
        title={'Confirm daily tally'}
        okButton={
          <LoadingButton
            label={'Confirm'}
            color="secondary"
            variant="contained"
            isLoading={isSaving}
            onClick={async () => {
              setConfirmSummaryOpen(false);
              await onConfirm(true);
            }}
          />
        }
        cancelButton={
          <DialogButton variant="cancel" onClick={() => setConfirmSummaryOpen(false)} />
        }
      >
        <Stack spacing={1} sx={{ minWidth: 760, maxHeight: 420, overflowY: 'auto' }}>
          {confirmSummaryRows.length > 0 ? (
            <Box
              display="grid"
              gridTemplateColumns="minmax(280px,2fr) minmax(140px,1fr) minmax(140px,1fr) minmax(140px,1fr)"
              columnGap={1}
              rowGap={0.75}
              alignItems="center"
            >
              <Typography variant="caption" sx={{ fontWeight: 700 }}>
                Item
              </Typography>
              <Typography variant="caption" sx={{ fontWeight: 700 }}>
                Batch
              </Typography>
              <Typography variant="caption" sx={{ fontWeight: 700 }}>
                Issued
              </Typography>
              <Typography variant="caption" sx={{ fontWeight: 700 }}>
                Wastage
              </Typography>
              {confirmSummaryRows.map((summaryRow, index) => (
                <React.Fragment
                  key={`${summaryRow.item}-${summaryRow.batch}-${summaryRow.issued}-${index}`}
                >
                  <Typography variant="body2">{summaryRow.item}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {summaryRow.batch}
                  </Typography>
                  <Typography variant="body2">{summaryRow.issued}</Typography>
                  <Typography variant="body2">{summaryRow.wastage}</Typography>
                </React.Fragment>
              ))}
            </Box>
          ) : (
            <Typography variant="body2" color="text.secondary">
              No summary lines available.
            </Typography>
          )}
        </Stack>
      </ConfirmSummaryModal>

      <AppBarContentPortal
        sx={{
          paddingBottom: '16px',
          flex: 1,
          justifyContent: 'space-between',
          display: 'flex',
          alignItems: 'center',
          gap: 2,
        }}
      >
        <Box display="flex" gap={2} alignItems="center">
          <Typography fontWeight="bold">Daily Tally</Typography>
          <BasicTextInput
            size="small"
            placeholder="Daily tally reference"
            value={referenceText}
            onChange={event => setReferenceText(event.target.value)}
            sx={{ width: 280 }}
          />
          <BasicTextInput
            size="small"
            placeholder={t('placeholder.filter-items')}
            value={filterText}
            onChange={event => setFilterText(event.target.value)}
            sx={{ width: 260 }}
          />
        </Box>
      </AppBarContentPortal>

      <AppBarButtonsPortal>
        <LoadingButton
          startIcon={<SaveIcon />}
          label={'Confirm'}
          color="secondary"
          variant="contained"
          onClick={() => onConfirm()}
          isLoading={isSaving}
        />
      </AppBarButtonsPortal>

      <Box paddingBottom={2}>
        <Box
          display="flex"
          alignItems="center"
          gap={2}
          sx={{ paddingX: 2, paddingBottom: 1 }}
        >
          <Typography sx={{ minWidth: 100 }}>{t('label.patient')}</Typography>
          <PatientSearchInput
            value={patient}
            onChange={setPatient}
            width={360}
            allowCreate
            mountSlidePanel
            showAllOnEmpty
          />
        </Box>
        <MaterialTable table={table} />
      </Box>
    </>
  );
};
