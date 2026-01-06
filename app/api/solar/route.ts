import { NextResponse } from 'next/server';
import pool from '@/lib/db';

export async function GET() {
  try {
    const client = await pool.connect();

    // 1. 발전소 목록 및 최신 로그
    const siteQuery = `SELECT s.id, s.name, s.lat, s.lng, s.capacity, l.gen, l.cons, l.sales, l.eff, l.status, l.ai_msg, l.is_error FROM solar_sites s LEFT JOIN LATERAL (SELECT * FROM solar_logs WHERE site_id = s.id ORDER BY recorded_at DESC LIMIT 1) l ON true ORDER BY s.id ASC`;
    const { rows: sites } = await client.query(siteQuery);

    // 2. 조치사항 및 차트 데이터 병합
    for (let site of sites) {
      const { rows: actions } = await client.query(
        'SELECT action_text FROM solar_actions WHERE site_id = $1',
        [site.id]
      );
      site.actions = actions.map((a: any) => a.action_text);
      site.chartData = site.is_error
        ? [90, 160, 150, 140, 80, 20]
        : [100, 320, 500, 750, 850, 600];
    }

    // 3. 기타 데이터 조회 (수익, 인버터, 통계, 시장가, 일정)
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
    console.error('DB Error:', error); // Vercel 로그 확인용
    return NextResponse.json({ error: 'Database Error' }, { status: 500 });
  }
}
