import { NextResponse } from 'next/server';
import pool from '@/lib/db';

export async function GET() {
  try {
    const client = await pool.connect();

    // 1. [Master Data] 발전소 및 최신 로그 조회
    // l.temp (온도) 컬럼 포함 확인
    const siteQuery = `
      SELECT s.id, s.name, s.lat, s.lng, s.capacity, 
             l.gen, l.cons, l.status, l.ai_msg, l.is_error,
             l.chart_labels, l.chart_values, l.weather, l.fail_date,
             l.recorded_at,
             l.temp
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

    // 2. 사이트별 데이터 가공
    for (let site of sites) {
      // 매전량 계산
      const calculatedSales = (site.gen || 0) - (site.cons || 0);
      site.sales = calculatedSales > 0 ? calculatedSales : 0;

      // 효율 계산
      let rawEff = 0;
      if (site.capacity > 0) {
        rawEff = ((site.gen || 0) / site.capacity) * 100;
        site.eff = rawEff > 100 ? 99.9 : parseFloat(rawEff.toFixed(1));
      } else {
        site.eff = 0;
      }

      // 손실 금액 계산
      const SMP = 160;
      if (site.is_error) {
        site.loss_amt = Math.floor(site.capacity * SMP).toLocaleString();
      } else if (site.status === 'warning') {
        site.loss_amt = Math.floor(site.capacity * 0.2 * SMP).toLocaleString();
      } else {
        site.loss_amt = 0;
      }

      // 🌟 [날씨 및 상태 보정 로직]
      const w = site.weather ? site.weather.toLowerCase() : '';
      const isBadWeather =
        w.includes('cloud') ||
        w.includes('rain') ||
        w.includes('snow') ||
        w.includes('mist') ||
        w.includes('haze') ||
        w.includes('fog');

      if (isBadWeather) {
        // 기상 악화 시 효율이 낮아도 '정상' 처리 + AI 메시지 생성
        if (!site.is_error && site.eff < 10) {
          site.status = 'normal';
          let cause = '기상 악화';
          if (w.includes('snow')) cause = '폭설';
          else if (w.includes('rain')) cause = '우천';
          else if (
            w.includes('mist') ||
            w.includes('haze') ||
            w.includes('fog')
          )
            cause = '안개/연무';

          site.ai_msg = `${cause}로 인한 발전량 감소 (설비 정상)`;
        }
      } else if (!site.is_error && site.eff > 0 && site.eff < 10) {
        // 맑은데 효율 낮음 -> 경고
        site.status = 'warning';
        site.ai_msg = '발전 효율 급격 저하 (점검 요망)';
      }

      // 🌟 [추가됨] AI 메시지가 여전히 없으면(정상 상태), 기본 문구 설정
      if (!site.ai_msg) {
        if (site.is_error) site.ai_msg = '설비 장애 발생 (긴급 점검 필요)';
        else site.ai_msg = '현재 특이사항 없음 (최적 효율 운전 중)';
      }

      // 전체 집계
      totalGen += site.gen || 0;
      totalCapacity += site.capacity || 0;
      totalSales += site.sales;
      if (site.capacity > 0) {
        totalEffSum += site.eff;
        activeSiteCount++;
      }

      // 조치사항
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

    // 인버터 데이터 생성
    const inverters = sites.map((site) => ({
      id: site.id,
      name: `${site.name} 인버터 #1`,
      efficiency: site.eff,
      status: site.status === 'danger' ? 'critical' : site.status,
      capacity: site.capacity,
      install_date: '2023-01-15',
      last_maintenance: site.fail_date || '2025-01-10',
    }));

    // 수익 데이터
    const { rows: revenue } = await client.query(
      'SELECT id, month, amount FROM solar_revenue ORDER BY id ASC'
    );
    if (revenue.length > 0) {
      const estimatedMonthlyRevenue = Math.floor(totalSales * 3.6 * 30 * 160);
      revenue[revenue.length - 1].amount = estimatedMonthlyRevenue;
    }

    // 통계 데이터
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

    // 기타 데이터
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
    console.error('API Error:', error);
    return NextResponse.json({ error: 'Database Error' }, { status: 500 });
  }
}

// 5초마다 호출되는 IoT 데이터 수신용 API
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      site_id, // 프론트엔드에서 보낸 ID 수신
      temperature,
      humidity,
      weather_condition,
      voltage,
      current,
      power_generation,
    } = body;

    const client = await pool.connect();

    const status = power_generation > 0 ? 'normal' : 'warning';

    // site_id가 없으면 1번으로 저장
    const targetSiteId = site_id || 1;

    // 데이터 저장
    await client.query(
      `INSERT INTO solar_logs (site_id, gen, cons, weather, status, recorded_at, temp, humid)
       VALUES ($1, $2, 0, $3, $4, NOW(), $5, $6)`,
      [
        targetSiteId,
        power_generation,
        weather_condition,
        status,
        temperature,
        humidity,
      ]
    );

    // 24시간 지난 데이터 삭제 (Self-Cleaning)
    await client.query(
      `DELETE FROM solar_logs WHERE recorded_at < NOW() - INTERVAL '24 hours'`
    );

    client.release();
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Post Error:', error);
    return NextResponse.json({ error: 'Save Failed' }, { status: 500 });
  }
}
