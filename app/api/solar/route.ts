import { NextResponse } from 'next/server';
import pool from '@/lib/db';

export async function GET() {
  try {
    const client = await pool.connect();

    // 1. 기본 데이터 조회 (logs의 sales, eff는 이제 무시하고 gen, cons만 믿습니다)
    const siteQuery = `
      SELECT s.id, s.name, s.lat, s.lng, s.capacity, 
             l.gen, l.cons, l.status, l.ai_msg, l.is_error,
             l.chart_labels, l.chart_values 
      FROM solar_sites s 
      LEFT JOIN LATERAL (SELECT * FROM solar_logs WHERE site_id = s.id ORDER BY recorded_at DESC LIMIT 1) l ON true
      ORDER BY s.id ASC
    `;
    const { rows: sites } = await client.query(siteQuery);

    // 2. [핵심] 서버 사이드 실시간 계산 로직 (Real-time Calculation) 🧮
    for (let site of sites) {
      // (1) 매전량 자동 계산: 발전량 - 소비량 (음수면 0)
      // DB에 저장된 값이 아니라, 지금 조회하는 시점에 계산합니다.
      const calculatedSales = (site.gen || 0) - (site.cons || 0);
      site.sales = calculatedSales > 0 ? calculatedSales : 0;

      // (2) 효율 자동 계산: (발전량 / 설비용량) * 보정계수
      // *참고: 실제 효율은 일사량 등 복잡하지만, 여기선 용량 대비 발전 비율로 계산
      if (site.capacity > 0) {
        // 예: 1000kW 설비가 800kW 발전 중이면 -> 80% 가동 효율
        // (단, 수치가 너무 작게 나오지 않게 연출용 보정 로직 추가 가능)
        let rawEff = ((site.gen || 0) / site.capacity) * 100;

        // 데모용 보정: 너무 낮으면(밤 등) 0, 아니면 보기 좋게 소수점 1자리
        site.eff = rawEff > 100 ? 99.9 : parseFloat(rawEff.toFixed(1));
      } else {
        site.eff = 0;
      }

      // (3) 상태값 자동 판별 (데이터 기반)
      // 효율이 10% 미만이고 고장이 아니면 -> 'warning'으로 강제 변환
      if (!site.is_error && site.eff > 0 && site.eff < 10) {
        site.status = 'warning';
        site.ai_msg = '발전 효율이 급격히 저하되었습니다. (Low Efficiency)';
      }

      // 조치사항 및 차트 데이터 처리 (기존 동일)
      const { rows: actions } = await client.query(
        'SELECT action_text FROM solar_actions WHERE site_id = $1',
        [site.id]
      );
      site.actions = actions.map((a: any) => a.action_text);

      site.chartData = site.chart_values || [0, 0, 0, 0, 0, 0];
      site.chartLabels = site.chart_labels || ['-', '-', '-', '-', '-', '-'];
    }

    // 3. 나머지 데이터 조회 (기존 동일)
    const { rows: revenue } = await client.query(
      'SELECT month, amount FROM solar_revenue ORDER BY id ASC'
    );
    const { rows: inverters } = await client.query(
      'SELECT * FROM solar_inverter_status ORDER BY id ASC'
    );

    const { rows: statsRows } = await client.query('SELECT * FROM solar_stats');
    const stats = statsRows.reduce((acc: any, cur: any) => {
      acc[cur.key_name] = cur.val;
      return acc;
    }, {});

    const { rows: marketRows } = await client.query(
      'SELECT * FROM solar_market'
    );
    const market = marketRows.reduce((acc: any, cur: any) => {
      acc[cur.type] = cur;
      return acc;
    }, {});

    const { rows: schedule } = await client.query(
      'SELECT * FROM solar_schedule ORDER BY id ASC'
    );

    client.release();

    return NextResponse.json({
      sites,
      revenue,
      inverters,
      stats,
      market,
      schedule,
    });
  } catch (error) {
    console.error('DB Error:', error);
    return NextResponse.json({ error: 'Database Error' }, { status: 500 });
  }
}
