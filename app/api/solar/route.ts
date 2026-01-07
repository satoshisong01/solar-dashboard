import { NextResponse } from 'next/server';
import pool from '@/lib/db';

export async function GET() {
  try {
    const client = await pool.connect();

    // ---------------------------------------------------------
    // 1. [Master Data] 발전소 및 로그 조회
    // ---------------------------------------------------------
    const siteQuery = `
      SELECT s.id, s.name, s.lat, s.lng, s.capacity, 
             l.gen, l.cons, l.status, l.ai_msg, l.is_error,
             l.chart_labels, l.chart_values 
      FROM solar_sites s 
      LEFT JOIN LATERAL (SELECT * FROM solar_logs WHERE site_id = s.id ORDER BY recorded_at DESC LIMIT 1) l ON true
      ORDER BY s.id ASC
    `;
    const { rows: sites } = await client.query(siteQuery);

    // 🌟 실시간 집계 변수 (계산용)
    let totalGen = 0; // 총 발전량
    let totalCapacity = 0; // 총 설비 용량
    let totalSales = 0; // 총 매전량
    let totalEffSum = 0; // 효율 합계
    let activeSiteCount = 0; // 가동 중인 사이트 수

    // 2. 사이트별 실시간 계산
    for (let site of sites) {
      // (1) 매전량 = 발전 - 소비
      const calculatedSales = (site.gen || 0) - (site.cons || 0);
      site.sales = calculatedSales > 0 ? calculatedSales : 0;

      // (2) 효율 = (발전 / 용량) * 100
      let rawEff = 0;
      if (site.capacity > 0) {
        rawEff = ((site.gen || 0) / site.capacity) * 100;
        // 데모용 보정: 100% 넘으면 99.9%, 너무 낮으면 0
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
        activeSiteCount++; // 설비가 있으면 일단 가동 모수로 봄
      }

      // 부가 정보
      const { rows: actions } = await client.query(
        'SELECT action_text FROM solar_actions WHERE site_id = $1',
        [site.id]
      );
      site.actions = actions.map((a: any) => a.action_text);

      site.chartData = site.chart_values || [0, 0, 0, 0, 0, 0];
      site.chartLabels = site.chart_labels || ['-', '-', '-', '-', '-', '-'];
    }

    // 전체 평균 효율 (Global Average Efficiency)
    const globalAvgEff =
      activeSiteCount > 0
        ? parseFloat((totalEffSum / activeSiteCount).toFixed(1))
        : 0;

    // ---------------------------------------------------------
    // 3. [데이터 동기화] 통계/수익/인버터 데이터를 실시간 발전량에 맞춤
    // ---------------------------------------------------------

    // (A) 수익 데이터 (이번 달 예측)
    const { rows: revenue } = await client.query(
      'SELECT id, month, amount FROM solar_revenue ORDER BY id ASC'
    );
    if (revenue.length > 0) {
      // 총 매전량 기반으로 이번 달 수익 뻥튀기 (데모용)
      const estimatedMonthlyRevenue = Math.floor((totalSales * 5.5) / 10);
      revenue[revenue.length - 1].amount = estimatedMonthlyRevenue;
    }

    // (B) 인버터 데이터 (효율 동기화)
    const { rows: inverters } = await client.query(
      'SELECT * FROM solar_inverter_status ORDER BY id ASC'
    );
    inverters.forEach((inv, idx) => {
      if (sites[idx]) {
        inv.efficiency = sites[idx].eff;
        inv.status =
          sites[idx].status === 'danger' ? 'critical' : sites[idx].status;
      }
    });

    // (C) ⭐ 통계 데이터 (여기가 질문하신 부분!)
    const { rows: statsRows } = await client.query('SELECT * FROM solar_stats');
    const stats = statsRows.reduce((acc: any, cur: any) => {
      acc[cur.key_name] = cur.val;
      return acc;
    }, {});

    // 1. 일조 시간 (Sunlight Hours)
    // 평균 효율(%)을 시간으로 환산하는 로직 (예: 효율 80% -> 약 6.1시간)
    // 발전량이 0이면 일조시간도 0이 됨
    const calculatedSunlight =
      globalAvgEff > 0 ? (globalAvgEff / 13).toFixed(1) : 0;
    stats['sunlight_hours'] = calculatedSunlight;

    // 2. 탄소 저감량 (Carbon Reduction)
    // 발전량(kWh) * 0.424kg (탄소배출계수) -> 톤(ton) 단위 변환
    // 값이 너무 작게 나오지 않게 누적치 느낌으로 * 0.5 정도 가중치 줌
    const calculatedCarbon =
      totalGen > 0 ? (((totalGen * 0.424) / 1000) * 10).toFixed(2) : 0;
    stats['carbon_reduction'] = calculatedCarbon;

    // 3. 설비 가동률 (Operation Rate)
    // (현재 총 발전량 / 총 설비 용량) * 100 -> 전체 설비가 얼마나 풀가동 중인지
    const calculatedOpRate =
      totalCapacity > 0 ? ((totalGen / totalCapacity) * 100).toFixed(1) : 0;
    stats['operation_rate'] = calculatedOpRate;

    // 4. 건강 점수 (Health Score)
    stats['health_score'] =
      globalAvgEff > 90 ? 98 : globalAvgEff > 70 ? 85 : 60;

    // (D) 나머지 고정 데이터
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
