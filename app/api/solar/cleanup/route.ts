import { NextResponse } from 'next/server';
import pool from '@/lib/db';

/**
 * 24시간 지난 solar_logs 삭제.
 * Vercel Cron으로 하루 1회 호출 권장 (vercel.json crons).
 */
export async function GET() {
  const client = await pool.connect();
  try {
    const { rowCount } = await client.query(
      `DELETE FROM solar_logs WHERE recorded_at < NOW() - INTERVAL '24 hours'`
    );
    return NextResponse.json({ deleted: rowCount ?? 0 });
  } catch (error) {
    console.error('Cleanup Error:', error);
    return NextResponse.json({ error: 'Cleanup Failed' }, { status: 500 });
  } finally {
    client.release();
  }
}
