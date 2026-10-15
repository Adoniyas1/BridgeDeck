function M = readmatrix(file, varargin)
  % BridgeDeck fill-in for MATLAB's readmatrix (numbers from a CSV or text file; a header row is skipped).
  try
    M = dlmread(file, ',');
  catch
    M = dlmread(file);
  end
  if ~isempty(M) && all(M(1, :) == 0)
    fid = fopen(file); first = fgetl(fid); fclose(fid);
    if any(isletter(first)), M = M(2:end, :); end
  end
end
