import { NextResponse } from 'next/server';
import pool from '@/lib/db';

export async function GET() {
  try {
    const client = await pool.connect();

    // 1. [Master Data] 발전소 및 로그 조회
    // (여기서 가져온 gen, cons가 모든 계산의 기준이 됩니다)
    const siteQuery = `
      SELECT s.id, s.name, s.lat, s.lng, s.capacity, 
             l.gen, l.cons, l.status, l.ai_msg, l.is_error,
             l.chart_labels, l.chart_values 
      FROM solar_sites s 
      LEFT JOIN LATERAL (SELECT * FROM solar_logs WHERE site_id = s.id ORDER BY recorded_at DESC LIMIT 1) l ON true
      ORDER BY s.id ASC
    `;
    const { rows: sites } = await client.query(siteQuery);

    // 🌟 실시간 집계 변수 (Real-time Aggregation)
    let totalGen = 0;
    let totalCapacity = 0;
    let totalSales = 0;
    let totalEffSum = 0;
    let activeSiteCount = 0;

    // 2. 사이트별 실시간 계산 (Calculations)
    for (let site of sites) {
      // (1) 매전량 자동 계산 (발전 - 소비)
      const calculatedSales = (site.gen || 0) - (site.cons || 0);
      site.sales = calculatedSales > 0 ? calculatedSales : 0;

      // (2) 효율 자동 계산 (발전량 / 설비용량)
      let rawEff = 0;
      if (site.capacity > 0) {
        rawEff = ((site.gen || 0) / site.capacity) * 100;
        // 데모용 보정: 100% 넘어가면 99.9%로, 너무 낮으면 0
        site.eff = rawEff > 100 ? 99.9 : parseFloat(rawEff.toFixed(1));
      } else {
        site.eff = 0;
      }

      // (3) 상태값 자동 판별
      if (!site.is_error && site.eff > 0 && site.eff < 10) {
        site.status = 'warning';
        site.ai_msg = '발전 효율 급격 저하 (Low Efficiency)';
      }

      // 집계 누적
      totalGen += site.gen || 0;
      totalCapacity += site.capacity || 0;
      totalSales += site.sales;
      if (site.capacity > 0) {
        totalEffSum += site.eff;
        activeSiteCount++;
      }

      // 부가 정보 조회
      const { rows: actions } = await client.query(
        'SELECT action_text FROM solar_actions WHERE site_id = $1',
        [site.id]
      );
      site.actions = actions.map((a: any) => a.action_text);

      site.chartData = site.chart_values || [0, 0, 0, 0, 0, 0];
      site.chartLabels = site.chart_labels || ['-', '-', '-', '-', '-', '-'];
    }

    // 🌟 전체 평균 효율 계산
    const globalAvgEff =
      activeSiteCount > 0
        ? parseFloat((totalEffSum / activeSiteCount).toFixed(1))
        : 0;

    // ---------------------------------------------------------
    // 3. [데이터 동기화] 다른 탭 데이터들도 Master Data(발전량) 따라가게 만들기
    // ---------------------------------------------------------

    // (A) 수익 데이터 (Revenue Tab)
    // DB의 월별 수익 데이터를 가져오되, '이번 달' 예상 수익은 실시간 발전량 기반으로 덮어씌움
    const { rows: revenue } = await client.query(
      'SELECT id, month, amount FROM solar_revenue ORDER BY id ASC'
    );
    if (revenue.length > 0) {
      // 단순 예측: 현재 시간당 매전량 * 24시간 * 30일 * SMP(대략 150원) / 10000(만원단위)
      // 데모를 위해 적절히 큰 숫자로 뻥튀기해서 보여줍니다.
      const estimatedMonthlyRevenue = Math.floor((totalSales * 5.5) / 10);
      // 마지막 데이터(이번달)를 실시간 예측치로 교체
      revenue[revenue.length - 1].amount = estimatedMonthlyRevenue;
    }

    // (B) 인버터 데이터 (Efficiency Tab)
    // DB의 인버터 목록을 가져오되, 효율(efficiency) 값은 사이트의 실시간 효율로 덮어씌움
    const { rows: inverters } = await client.query(
      'SELECT * FROM solar_inverter_status ORDER BY id ASC'
    );
    // 사이트 개수만큼 인버터 효율 업데이트 (1:1 매핑 가정)
    inverters.forEach((inv, idx) => {
      if (sites[idx]) {
        inv.efficiency = sites[idx].eff; // 사이트 효율을 인버터 효율로 복사
        inv.status =
          sites[idx].status === 'danger' ? 'critical' : sites[idx].status; // 상태 동기화
      }
    });

    // (C) 통계 데이터 (Header Stats)
    const { rows: statsRows } = await client.query('SELECT * FROM solar_stats');
    const stats = statsRows.reduce((acc: any, cur: any) => {
      acc[cur.key_name] = cur.val;
      return acc;
    }, {});

    // 통계 수치도 실시간 데이터로 덮어씌움!
    stats['health_score'] =
      globalAvgEff > 90 ? 95 : globalAvgEff > 70 ? 85 : 60; // 평균 효율 기반 점수
    stats['operation_rate'] =
      activeSiteCount > 0
        ? (
            ((activeSiteCount - sites.filter((s: any) => s.is_error).length) /
              activeSiteCount) *
            100
          ).toFixed(1)
        : 0; // 가동률 재계산

    // (D) 나머지 (시장가, 일정) - 얘는 고정값 유지
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
