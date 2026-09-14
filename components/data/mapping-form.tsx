'use client';

import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import type { CreatePointData } from '@/app/(console)/data/actions';
import { ActionMessage, echoed, fieldError, SelectField, SubmitButton, TextField } from '@/components/forms/controls';
import type { ActionState } from '@/lib/forms/action-state';

export interface AssetOption {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly className: string;
}

export interface MetricOption {
  readonly key: string;
  readonly name: string;
  readonly unit: string;
}

type MappingFormProps = Readonly<{
  gatewayId: number;
  sourceKey: string;
  sourceUnit: string | null;
  assets: readonly AssetOption[];
  metrics: readonly MetricOption[];
  state: ActionState<CreatePointData>;
  action: (formData: FormData) => void;
}>;

function UnitHint({ metric, sourceUnit }: Readonly<{ metric: MetricOption | undefined; sourceUnit: string | null }>) {
  if (!metric) return <>메트릭을 고르면 정규 단위를 보여 줍니다.</>;
  const same = (sourceUnit ?? '') === metric.unit;
  return (
    <>
      정규 단위 <span className="font-mono">{metric.unit || '무차원'}</span> · 원본 단위 <span className="font-mono">{sourceUnit || '없음'}</span>
      {!same && <span className="text-warn"> — 단위가 다르면 배율·오프셋으로 변환하세요</span>}
    </>
  );
}

/** 인박스 태그 → (설비, 메트릭, 구분자) 포인트. 정규값 = 원본값 × 배율 + 오프셋 */
export function MappingForm({ gatewayId, sourceKey, sourceUnit, assets, metrics, state, action }: MappingFormProps) {
  const [metricKey, setMetricKey] = useState(echoed(state, 'metricKey'));
  const selectedMetric = metrics.find((metric) => metric.key === metricKey);

  return (
    <form key={state.seq} action={action} className="flex flex-col gap-4">
      <input type="hidden" name="gatewayId" value={gatewayId} />
      <input type="hidden" name="sourceKey" value={sourceKey} />

      <div className="grid gap-4 md:grid-cols-2">
        <SelectField label="설비" name="assetId" required defaultValue={echoed(state, 'assetId')} error={fieldError(state, 'assetId')} hint="이 게이트웨이 사이트의 설비만 보입니다.">
          <option value="">설비를 고르세요</option>
          {assets.map((asset) => (
            <option key={asset.id} value={asset.id}>
              {asset.code} · {asset.name} ({asset.className})
            </option>
          ))}
        </SelectField>
        <SelectField
          label="메트릭"
          name="metricKey"
          required
          defaultValue={echoed(state, 'metricKey')}
          onChange={(event) => setMetricKey(event.target.value)}
          error={fieldError(state, 'metricKey')}
          hint={<UnitHint metric={selectedMetric} sourceUnit={sourceUnit} />}
        >
          <option value="">메트릭을 고르세요</option>
          {metrics.map((metric) => (
            <option key={metric.key} value={metric.key}>
              {metric.name} — {metric.key}
              {metric.unit ? ` [${metric.unit}]` : ''}
            </option>
          ))}
        </SelectField>
      </div>

      <p className="-mt-2 text-xs">
        <Link href="/settings/catalog/metrics/new" className="inline-flex items-center gap-1 font-medium text-accent hover:underline">
          <Plus aria-hidden="true" className="size-3.5" />
          맞는 메트릭이 없으면 새 메트릭 추가
        </Link>
      </p>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <TextField label="구분자 (선택)" name="qualifier" defaultValue={echoed(state, 'qualifier')} error={fieldError(state, 'qualifier')} placeholder="예: inlet" hint="같은 설비에 같은 메트릭이 여럿일 때" maxLength={32} />
        <TextField label="배율" name="scale" inputMode="decimal" defaultValue={echoed(state, 'scale', '1')} error={fieldError(state, 'scale')} hint="예: mV → V는 0.001" />
        <TextField label="오프셋" name="valueOffset" inputMode="decimal" defaultValue={echoed(state, 'valueOffset', '0')} error={fieldError(state, 'valueOffset')} hint="예: K → °C는 -273.15" />
        <TextField label="수집 주기(초, 선택)" name="periodS" inputMode="numeric" defaultValue={echoed(state, 'periodS')} error={fieldError(state, 'periodS')} placeholder="예: 60" />
      </div>
      <p className="text-xs text-muted">정규값 = 원본값 × 배율 + 오프셋. 매핑 이후 수신분은 바로 적재되고, 과거 값은 다음 단계의 재처리로 채웁니다.</p>

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingText="만드는 중…">포인트 만들기</SubmitButton>
      </div>
      {state.status === 'error' && <ActionMessage state={state} />}
    </form>
  );
}
