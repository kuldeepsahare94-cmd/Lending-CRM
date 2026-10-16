/* My route of the day. */
import { TopBar, BottomNav, StatusBars } from '../components/ui';
import DayRoute from '../components/DayRoute';

export default function MyDay() {
  return (
    <div className="screen">
      <TopBar title="My route" />
      <StatusBars />
      <div className="body"><DayRoute /></div>
      <BottomNav />
    </div>
  );
}
