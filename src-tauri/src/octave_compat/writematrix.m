function writematrix(M, file, varargin)
  % BridgeDeck fill-in for MATLAB's writematrix (comma-separated).
  if nargin < 2, file = 'matrix.txt'; end
  dlmwrite(file, M, ',');
end
