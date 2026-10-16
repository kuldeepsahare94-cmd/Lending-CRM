import { lazy } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

const Dashboard = lazy(() => import('../Dashboard'));

// After sign-in, people who can see loans land on the loan dashboard.
// Everyone else keeps the general dashboard.
export default function LoanHome() {
  const { user } = useAuth();
  return user?.permissions?.loans?.view ? <Navigate to="/loans" replace /> : <Dashboard />;
}
