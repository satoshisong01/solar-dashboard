import { NextResponse } from 'next/server';
import pool from '@/lib/db';

export async function GET() {
  try {
    const client = await pool.connect();

    // 1. [Master Data] 발전소 및 최신 로그 조회
    // 🌟 [수정됨] 정렬을 위해 l.recorded_at (발생 시간) 컬럼을 추가했습니다.
    const siteQuery = `
      SELECT s.id, s.name, s.lat, s.lng, s.capacity, 
             l.gen, l.cons, l.status, l.ai_msg, l.is_error,
             l.chart_labels, l.chart_values, l.weather, l.fail_date,
             l.recorded_at
      FROM solar_sites s 
      LEFT JOIN LATERAL (SELECT * FROM solar_logs WHERE site_id = s.id ORDER BY recorded_at DESC LIMIT 1) l ON true
      ORDER BY s.id ASC
    `;
    const { rows: sites } = await client.query(siteQuery);

    // 집계 변수 초기화
    let totalGen = 0;
    let totalCapacity = 0;
    let totalSales = 0;
    let totalEffSum = 0;
    let activeSiteCount = 0;

    // 2. 사이트별 실시간 데이터 가공 및 계산
    for (let site of sites) {
      // (1) 매전량 자동 계산 (발전 - 소비)
      const calculatedSales = (site.gen || 0) - (site.cons || 0);
      site.sales = calculatedSales > 0 ? calculatedSales : 0;

      // (2) 효율 자동 계산 (발전량 / 설비용량 * 100)
      let rawEff = 0;
      if (site.capacity > 0) {
        rawEff = ((site.gen || 0) / site.capacity) * 100;
        site.eff = rawEff > 100 ? 99.9 : parseFloat(rawEff.toFixed(1));
      } else {
        site.eff = 0;
      }

      // (3) 💰 손실 금액 계산 (시간당)
      // SMP(계통한계가격) 가정: 1kWh당 160원
      const SMP = 160;
      if (site.is_error) {
        // 고장이면 용량 전체만큼 손해
        site.loss_amt = Math.floor(site.capacity * SMP).toLocaleString();
      } else if (site.status === 'warning') {
        // 경고 상태면 효율 저하분(약 20% 가정) 만큼 손해
        site.loss_amt = Math.floor(site.capacity * 0.2 * SMP).toLocaleString();
      } else {
        site.loss_amt = 0;
      }

      // (4) 날씨 및 상태 보정 로직
      if (site.weather === 'cloudy' || site.weather === 'rainy') {
        // 흐린 날은 효율이 낮아도 정상이므로 경고 해제
        if (!site.is_error && site.eff < 10) {
          site.status = 'normal';
          site.ai_msg = '기상 악화로 인한 발전량 감소 (설비 정상)';
        }
      } else if (!site.is_error && site.eff > 0 && site.eff < 10) {
        // 맑은데 효율이 낮으면 진짜 경고
        site.status = 'warning';
        site.ai_msg = '발전 효율 급격 저하 (점검 요망)';
      }

      // 전체 집계 누적
      totalGen += site.gen || 0;
      totalCapacity += site.capacity || 0;
      totalSales += site.sales;
      if (site.capacity > 0) {
        totalEffSum += site.eff;
        activeSiteCount++;
      }

      // 부가 정보 (조치사항 및 차트 데이터)
      const { rows: actions } = await client.query(
        'SELECT action_text FROM solar_actions WHERE site_id = $1',
        [site.id]
      );
      site.actions = actions.map((a: any) => a.action_text);

      site.chartData = site.chart_values || [0, 0, 0, 0, 0, 0];
      site.chartLabels = site.chart_labels || ['-', '-', '-', '-', '-', '-'];
    }

    // 전체 평균 효율 계산
    const globalAvgEff =
      activeSiteCount > 0
        ? parseFloat((totalEffSum / activeSiteCount).toFixed(1))
        : 0;

    // ---------------------------------------------------------
    // 3. [데이터 동기화] 통계/수익/인버터 데이터를 실시간 발전량에 맞춤
    // ---------------------------------------------------------

    // (A) 수익 데이터 (Revenue Tab) - 현실적인 수익 공식 적용
    const { rows: revenue } = await client.query(
      'SELECT id, month, amount FROM solar_revenue ORDER BY id ASC'
    );
    if (revenue.length > 0) {
      // 💰 공식: (현재 총 발전량 kW) × (일평균 3.6시간) × (30일) × (SMP 160원)
      // 예: 4000kW 발전 시 월 약 6,900만원 수익 예상
      const estimatedMonthlyRevenue = Math.floor(totalSales * 3.6 * 30 * 160);
      revenue[revenue.length - 1].amount = estimatedMonthlyRevenue;
    }

    // (B) 인버터 데이터 (Efficiency Tab) - 효율 및 상태 동기화
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

    // (C) 통계 데이터 (Header Stats) - 실시간 역산
    const { rows: statsRows } = await client.query('SELECT * FROM solar_stats');
    const stats = statsRows.reduce((acc: any, cur: any) => {
      acc[cur.key_name] = cur.val;
      return acc;
    }, {});

    // 1. 일조 시간
    stats['sunlight_hours'] =
      globalAvgEff > 0 ? (globalAvgEff / 13).toFixed(1) : 0;
    // 2. 탄소 저감량 (30일 기준 현실적 수치로 보정)
    stats['carbon_reduction'] =
      totalGen > 0 ? (((totalGen * 0.424) / 1000) * 30).toFixed(2) : 0;
    // 3. 설비 가동률
    stats['operation_rate'] =
      totalCapacity > 0 ? ((totalGen / totalCapacity) * 100).toFixed(1) : 0;
    // 4. 건강 점수
    stats['health_score'] =
      globalAvgEff > 90 ? 98 : globalAvgEff > 70 ? 85 : 60;

    // (D) 기타 고정 데이터 (시장가, 일정)
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
