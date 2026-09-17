import type { Metadata } from 'next';
import { PageHeader } from '@/components/console/page-header';
import { SETTINGS_TABS, SectionTabs } from '@/components/console/section-tabs';
import { CreateAdminForm, UserActions } from '@/components/settings/admin-forms';
import { EmptyNote, Panel, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import { listConsoleUsers } from '@/lib/auth/admin-users';
import { requireAdmin } from '@/lib/auth/dal';
import { formatKstDateTime } from '@/lib/format';

export const metadata: Metadata = { title: '관리자' };

export default async function AdminSettingsPage() {
  const session = await requireAdmin();
  const { total, users } = await listConsoleUsers();

  return (
    <>
      <PageHeader title="설정" purpose="스키마 변경 없이 자산·메트릭 등록, 탐지기 파라미터, 키 회전, 관리자" />
      <SectionTabs label="설정 하위 화면" tabs={SETTINGS_TABS} current="/settings/admins" />

      <Panel title="관리자 계정 만들기" meta="가입은 비활성입니다. 계정은 여기서만 발급합니다">
        <CreateAdminForm />
      </Panel>

      <Panel title="계정" meta={`${total}명${total > users.length ? ` 중 ${users.length}명` : ''}`}>
        {users.length === 0 ? (
          <EmptyNote>계정이 없습니다</EmptyNote>
        ) : (
          <TableScroll label="계정 표" stickyFirst>
            <table className={TABLE_CLASS}>
              <thead>
                <tr>
                  <th scope="col" className={TH_CLASS}>이름 · 이메일</th>
                  <th scope="col" className={TH_CLASS}>역할</th>
                  <th scope="col" className={TH_CLASS}>상태</th>
                  <th scope="col" className={TH_CLASS}>만든 시각</th>
                  <th scope="col" className={TH_CLASS}>관리</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <th scope="row" className={`${TD_CLASS} font-normal`}>
                      <span className="font-medium text-ink">{user.name}</span>
                      {user.id === session.user.id && <span className="ml-2 rounded bg-hydrogen-fill px-1.5 py-px text-xs text-hydrogen">나</span>}
                      <span className="block text-xs text-ink-2">{user.email}</span>
                    </th>
                    <td className={`${TD_CLASS} text-ink-2`}>{user.role === 'admin' ? '관리자' : (user.role ?? '—')}</td>
                    <td className={TD_CLASS}>
                      {user.banned ? (
                        <span className="text-crit">
                          비활성
                          {user.banReason && <span className="block text-xs text-muted">{user.banReason}</span>}
                        </span>
                      ) : (
                        <span className="text-ok">활성</span>
                      )}
                    </td>
                    <td className={`${TD_CLASS} font-mono text-xs whitespace-nowrap`}>{formatKstDateTime(user.createdAtMs)}</td>
                    <td className={TD_CLASS}>
                      <UserActions userId={user.id} label={user.email} banned={user.banned} isSelf={user.id === session.user.id} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
        <p className="text-xs text-muted">관리자 역할이 아닌 계정은 로그인해도 콘솔에 들어오지 못합니다. 비활성하면 해당 계정의 세션도 모두 끝납니다.</p>
      </Panel>
    </>
  );
}
