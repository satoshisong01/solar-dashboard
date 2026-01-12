import { NextResponse } from 'next/server';
import pool from '@/lib/db';

export async function GET() {
  try {
    const client = await pool.connect();

    // 1. [Master Data] 발전소 및 최신 로그 조회
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

    let totalGen = 0;
    let totalCapacity = 0;
    let totalSales = 0;
    let totalEffSum = 0;
    let activeSiteCount = 0;

    for (let site of sites) {
      const calculatedSales = (site.gen || 0) - (site.cons || 0);
      site.sales = calculatedSales > 0 ? calculatedSales : 0;

      let rawEff = 0;
      if (site.capacity > 0) {
        rawEff = ((site.gen || 0) / site.capacity) * 100;
        site.eff = rawEff > 100 ? 99.9 : parseFloat(rawEff.toFixed(1));
      } else {
        site.eff = 0;
      }

      const SMP = 160;
      if (site.is_error) {
        site.loss_amt = Math.floor(site.capacity * SMP).toLocaleString();
      } else if (site.status === 'warning') {
        site.loss_amt = Math.floor(site.capacity * 0.2 * SMP).toLocaleString();
      } else {
        site.loss_amt = 0;
      }

      if (site.weather === 'cloudy' || site.weather === 'rainy') {
        if (!site.is_error && site.eff < 10) {
          site.status = 'normal';
          site.ai_msg = '기상 악화로 인한 발전량 감소 (설비 정상)';
        }
      } else if (!site.is_error && site.eff > 0 && site.eff < 10) {
        site.status = 'warning';
        site.ai_msg = '발전 효율 급격 저하 (점검 요망)';
      }

      totalGen += site.gen || 0;
      totalCapacity += site.capacity || 0;
      totalSales += site.sales;
      if (site.capacity > 0) {
        totalEffSum += site.eff;
        activeSiteCount++;
      }

      const { rows: actions } = await client.query(
        'SELECT action_text FROM solar_actions WHERE site_id = $1',
        [site.id]
      );
      site.actions = actions.map((a: any) => a.action_text);

      site.chartData = site.chart_values || [0, 0, 0, 0, 0, 0];
      site.chartLabels = site.chart_labels || ['-', '-', '-', '-', '-', '-'];
    }

    const globalAvgEff =
      activeSiteCount > 0
        ? parseFloat((totalEffSum / activeSiteCount).toFixed(1))
        : 0;

    const { rows: revenue } = await client.query(
      'SELECT id, month, amount FROM solar_revenue ORDER BY id ASC'
    );
    if (revenue.length > 0) {
      const estimatedMonthlyRevenue = Math.floor(totalSales * 3.6 * 30 * 160);
      revenue[revenue.length - 1].amount = estimatedMonthlyRevenue;
    }

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

    const { rows: statsRows } = await client.query('SELECT * FROM solar_stats');
    const stats = statsRows.reduce((acc: any, cur: any) => {
      acc[cur.key_name] = cur.val;
      return acc;
    }, {});

    stats['sunlight_hours'] =
      globalAvgEff > 0 ? (globalAvgEff / 13).toFixed(1) : 0;
    stats['carbon_reduction'] =
      totalGen > 0 ? (((totalGen * 0.424) / 1000) * 30).toFixed(2) : 0;
    stats['operation_rate'] =
      totalCapacity > 0 ? ((totalGen / totalCapacity) * 100).toFixed(1) : 0;
    stats['health_score'] =
      globalAvgEff > 90 ? 98 : globalAvgEff > 70 ? 85 : 60;

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

// 👇 [추가됨] 이 POST 함수가 없어서 405 에러가 났던 것입니다.
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      temperature,
      humidity,
      weather_condition,
      voltage,
      current,
      power_generation,
    } = body;

    const client = await pool.connect();

    // Site 1에 대해 시뮬레이션 데이터를 업데이트합니다. (데모용)
    // 실제로는 각 사이트별로 데이터를 받아야 하지만, 여기서는 1번 발전소를 업데이트합니다.
    const status = power_generation > 0 ? 'normal' : 'warning';

    // 로그 테이블에 새로운 데이터 삽입
    await client.query(
      `INSERT INTO solar_logs (site_id, gen, cons, weather, status, recorded_at, temp, humid)
       VALUES (1, $1, 0, $2, $3, NOW(), $4, $5)`,
      [power_generation, weather_condition, status, temperature, humidity]
    );

    client.release();
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('POST Error:', error);
    return NextResponse.json({ error: 'Save Failed' }, { status: 500 });
  }
}
